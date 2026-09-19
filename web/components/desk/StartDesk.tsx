"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { deskApi } from "@/lib/desk/api";
import { DEFAULT_CAPS, capsRows } from "@/lib/desk/caps";
import { CHAIN_ID, KIND_V3_LP, LANE_A } from "@/lib/desk/chain";
import { DESK_FACTORY, DESK_GUARDIAN, GAS_TARGET_WEI } from "@/lib/desk/config";
import { createOrList, judge, pendingText, preflight } from "@/lib/desk/create";
import { fmtEth, fmtUnits, fmtUsd, isZeroAddr, short } from "@/lib/desk/format";
import {
  capsAboveCeilings,
  laneSalt,
  predictLane,
  readEthBalances,
  readFactory,
  readLane,
  readLaneRoles,
  readPrices,
  readTokenBalances,
  type CreateParams,
  type LaneRoles,
} from "@/lib/desk/reads";
import { describeError } from "@/lib/desk/tx";
import type { AgentResult, DelegationView } from "@/lib/desk/types";
import { useDeskSession } from "./context";
import { DYNAMIC_SLOW_HINT, useAction, usePoll, useSlow, useStoredState } from "./hooks";
import ModePicker from "./ModePicker";
import type { DeskSession } from "./session";
import { Addr, Btn, Card, Meter, Notice, Status, TxLine, type Tone } from "./ui";
import VaultAlarm from "./VaultAlarm";

type WizardState = {
  operator: Address | null;
  operatorKind: "embedded" | "server" | null;
  gasAck: boolean;
  salt: Hex | null;
  predicted: Address | null;
  policyAck: boolean;
  lane: Address | null;
  fundAck: boolean;
  registered: boolean;
  /** The Operator desk-agent reported "active": Dynamic's delegation webhook reached it with the key share. */
  agentDelegation: Address | null;
  /** createLane put the lane somewhere other than the prediction the policy allowlist was set for. */
  moved: { from: Address; to: Address } | null;
  /** The earlier prediction the policy allowlist was set for, until the user confirms it now names the new one. */
  replaced: Address | null;
};
const INITIAL: WizardState = {
  operator: null,
  operatorKind: null,
  gasAck: false,
  salt: null,
  predicted: null,
  policyAck: false,
  lane: null,
  fundAck: false,
  registered: false,
  agentDelegation: null,
  moved: null,
  replaced: null,
};

const FUND_TARGET_USD = 50;
/** Step 6 polls desk-agent for the Operator's delegation this often, for this long, before explaining the wait. */
const DELEGATION_POLL_MS = 3000;
const DELEGATION_WAIT_MS = 120_000;
/**
 * desk-agent stamps its delegation records with its own clock, which may run ahead of the browser's. A "revoked" record
 * counts as newer than the current delegation only by more than this, so a clock difference can't make the previous
 * delegation's revoke look like this one's (the worst case of the margin: a real revoke shows at the timeout instead).
 */
const AGENT_CLOCK_SLACK_MS = 30_000;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const STEPS = [
  "Sign in: your Vault",
  "Create the Operator wallet",
  "Top up gas",
  "Predict the lane address",
  "Create the lane",
  "Delegate the Operator",
  "Fund the lane",
  "Register with the agent",
] as const;

export default function StartDesk() {
  const session = useDeskSession();
  if (!session)
    return (
      <Notice tone="warning" title="Dynamic not configured">
        Set <code className="font-mono">NEXT_PUBLIC_DYNAMIC_ENV_ID</code> to the Dynamic sandbox environment id and rebuild. Sign-in, the Vault and the Operator wallets all come from
        Dynamic&apos;s embedded wallets. Existing desks can still be viewed read-only at <code className="font-mono">/desk/&lt;lane address&gt;</code>.
      </Notice>
    );
  return <Wizard session={session} />;
}

function Wizard({ session }: { session: DeskSession }) {
  const vault = session.vault;
  const vaultAddr = vault ? getAddress(vault.address) : null;
  const [stored, set] = useStoredState<WizardState>(vaultAddr ? `deltadesk:wizard:${vaultAddr.toLowerCase()}` : null, INITIAL);
  const S = vaultAddr ? stored : INITIAL;
  const operator = S.operator;

  const factoryAddr = DESK_FACTORY;
  const factory = usePoll(factoryAddr && vaultAddr ? () => readFactory(factoryAddr, vaultAddr) : null, 15_000, `factory:${vaultAddr}`);
  const gas = usePoll(vaultAddr ? () => readEthBalances(operator ? [vaultAddr, operator] : [vaultAddr]) : null, 4000, `gas:${vaultAddr}:${operator}`);

  const [vaultEth, operatorEth] = gas.data ?? [];
  const gasOk = vaultEth != null && operatorEth != null && vaultEth >= GAS_TARGET_WEI.vault && operatorEth >= GAS_TARGET_WEI.operator;
  useEffect(() => {
    if (gasOk && !S.gasAck && vaultAddr) set({ gasAck: true });
  }, [gasOk, S.gasAck, vaultAddr, set]);

  // Dynamic's client-side status is the precondition; desk-agent confirming it holds the key share is the signal.
  const opDelegation = operator ? session.delegationOf(operator) : "unknown";
  const confirmed = same(S.agentDelegation, operator);
  const delegated = S.operatorKind === "server" || (opDelegation === "delegated" && confirmed);
  // That confirmation covers one Dynamic delegation: once Dynamic stops showing the Operator delegated, the next
  // delegation must be confirmed again.
  useEffect(() => {
    if (S.agentDelegation && session.sdkHasLoaded && opDelegation !== "delegated") set({ agentDelegation: null });
  }, [S.agentDelegation, session.sdkHasLoaded, opDelegation, set]);
  // It is also checked again on each visit until the desk is registered: desk-agent drops a delegation that no desk
  // claims within 24 h, and then step 6 has to run again. A failed check keeps it (registration re-checks anyway).
  const recheck = S.operatorKind === "embedded" && confirmed && opDelegation === "delegated" && !S.registered ? operator : null;
  const jwt = session.jwt;
  useEffect(() => {
    if (!recheck) return;
    let stop = false;
    deskApi<DelegationView>(`/delegations/${recheck}`, { jwt: jwt() }).then((r) => {
      const status = readDelegation(r, recheck).status;
      if (!stop && status && status !== "active") set({ agentDelegation: null });
    });
    return () => {
      stop = true;
    };
  }, [recheck, jwt, set]);
  const done = [!!vault, !!operator, S.gasAck, !!S.predicted && S.policyAck, !!S.lane, delegated, S.fundAck, S.registered];
  const active = done.findIndex((d) => !d);

  const params = (salt: Hex): CreateParams | null =>
    vaultAddr && operator ? { owner: vaultAddr, operator, guardian: DESK_GUARDIAN, laneId: 0, kind: KIND_V3_LP, pool: LANE_A.pool, caps: DEFAULT_CAPS, salt } : null;

  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const resume = async (lane: Address) => {
    setResumeNote(null);
    const s = await readLane(lane).catch(() => null);
    if (!s) return setResumeNote("Could not read that lane from the chain; try again.");
    if (isZeroAddr(s.operator)) return setResumeNote("That lane's agent was revoked, so there is no setup to continue. Open it to manage or withdraw.");
    set({ ...INITIAL, operator: s.operator, operatorKind: session.walletFor(s.operator) ? "embedded" : "server", gasAck: true, predicted: lane, policyAck: true, lane });
  };

  const stepBody = (i: number): ReactNode => {
    switch (i) {
      case 0:
        return <SignInStep session={session} />;
      case 1:
        return <OperatorStep session={session} vault={vaultAddr} onPick={(addr, kind) => set({ ...INITIAL, operator: addr, operatorKind: kind })} />;
      case 2:
        return <GasStep vault={vaultAddr} operator={operator} vaultEth={vaultEth} operatorEth={operatorEth} onSkip={() => set({ gasAck: true })} />;
      case 3:
        return <PredictStep owner={vaultAddr} factory={factory.data} factoryError={factory.error} params={params} state={S} set={set} />;
      case 4:
        return (
          <CreateStep
            session={session}
            params={S.salt ? params(S.salt) : null}
            predicted={S.predicted}
            onCreated={(lane) => set({ lane, moved: null })}
            onMoved={(from, to) => set({ predicted: to, policyAck: false, moved: { from, to } })}
            onRepredict={() => set({ predicted: null, policyAck: false, moved: null, replaced: S.replaced ?? S.predicted })}
            onRestart={() => set({ salt: null, predicted: null, policyAck: false, moved: null, replaced: S.replaced ?? S.predicted })}
          />
        );
      case 5:
        return <DelegateStep session={session} operator={operator} kind={S.operatorKind} onConfirmed={(op) => set({ agentDelegation: op })} />;
      case 6:
        return <FundStep lane={S.lane} onDone={() => set({ fundAck: true })} />;
      case 7:
        return <RegisterStep session={session} lane={S.lane} onRegistered={() => set({ registered: true })} onDelegationLost={() => set({ agentDelegation: null })} />;
    }
  };

  const summary = (i: number): ReactNode => {
    switch (i) {
      case 0:
        return vaultAddr && <Addr address={vaultAddr} />;
      case 1:
        return operator && (
          <>
            <Addr address={operator} /> <span className="text-xs text-muted">{S.operatorKind === "server" ? "DeltaDesk server wallet (Plan B)" : "embedded wallet"}</span>
          </>
        );
      case 2:
        return <span className="tabular text-ink-2">Vault {fmtEth(vaultEth)} · Operator {fmtEth(operatorEth)}</span>;
      case 3:
      case 4:
        return S.predicted && <Addr address={S.lane ?? S.predicted} />;
      case 5:
        return <span className="text-ink-2">{S.operatorKind === "server" ? "not needed (Plan B)" : "Operator delegated and confirmed by desk-agent; Vault not delegated"}</span>;
      case 6:
        return <span className="text-ink-2">funded</span>;
      case 7:
        return <span className="text-ink-2">registered</span>;
    }
  };

  const lanes = factory.data?.lanes ?? [];
  const desks = useYourDesks(lanes, vaultAddr, session, operator);
  // VaultAlarm explains why: with these settings on, Dynamic may offer to delegate the Vault, so no setup step runs.
  const blocked = session.unsafeDelegationSettings.length > 0;
  return (
    <div className="space-y-6">
      <VaultAlarm session={session} />
      {!DESK_FACTORY && !blocked && (
        <Notice tone="warning" title="Lane factory not deployed yet">
          <code className="font-mono">NEXT_PUBLIC_DESK_FACTORY</code> is unset. You can sign in, create the Operator and top up gas now; lane creation unlocks once the factory is deployed on
          Robinhood Chain.
        </Notice>
      )}
      {lanes.length > 0 && (
        <Card title="Your desks">
          {!desks.checked ? (
            <p className="text-sm text-ink-2">{desks.error ? `Could not check your desks on-chain: ${desks.error}` : "Checking your desks on-chain…"}</p>
          ) : (
            <>
              {desks.mine.length > 0 ? (
                <ul className="divide-y divide-[var(--grid)]">
                  {desks.mine.map((l) => (
                    <li key={l} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <Addr address={l} />
                      <div className="flex gap-2">
                        {!blocked && !same(S.lane, l) && (
                          <Btn kind="ghost" onClick={() => resume(l)}>
                            Continue setup
                          </Btn>
                        )}
                        <OpenLink lane={l} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-2">None of the lanes listed for your Vault has the roles this setup uses.</p>
              )}
              {desks.other.length > 0 && (
                <details className="rounded-lg bg-surface-2 p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    {desks.other.length} other lane{desks.other.length > 1 ? "s" : ""} listed for your Vault
                  </summary>
                  <p className="mt-2 text-ink-2">
                    Your Vault listed these, but their owner, operator or guardian is not what this setup uses, so setup can&apos;t continue on them. Open one to review it
                    or withdraw.
                  </p>
                  <ul className="mt-2 divide-y divide-[var(--grid)]">
                    {desks.other.map((o) => (
                      <li key={o.lane} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div className="min-w-0 space-y-1">
                          <Addr address={o.lane} />
                          <div className="text-xs text-ink-2">{o.why}</div>
                        </div>
                        <OpenLink lane={o.lane} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {resumeNote && <Status tone="warning">{resumeNote}</Status>}
        </Card>
      )}

      {!blocked && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <ol className="min-w-0 space-y-3">
            {STEPS.map((title, i) => {
              const state = active === -1 || i < active ? "done" : i === active ? "active" : "locked";
              return (
                <Step key={title} n={i + 1} title={title} state={state} summary={state === "done" ? summary(i) : null}>
                  {state === "active" && stepBody(i)}
                </Step>
              );
            })}
            {active === -1 && S.lane && (
              <Card>
                <Status tone="good">Your desk is set up.</Status>
                <Link href={`/desk/${S.lane}`} className="inline-flex min-h-10 items-center rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90">
                  Open your desk →
                </Link>
              </Card>
            )}
          </ol>

          <aside className="space-y-4">
            <Card title="What you are creating">
              <dl className="space-y-2 text-sm">
                <Row label="Vault (owner)">{vaultAddr ? <Addr address={vaultAddr} /> : "sign in"}</Row>
                <Row label="Operator (agent)">{operator ? <Addr address={operator} /> : "step 2"}</Row>
                <Row label="Lane">{S.lane || S.predicted ? <Addr address={(S.lane ?? S.predicted)!} /> : "step 4"}</Row>
                <Row label="Guardian">{isZeroAddr(DESK_GUARDIAN) ? "none" : <Addr address={DESK_GUARDIAN} />}</Row>
                <Row label="Pool">NVDA/USDG 0.05%</Row>
              </dl>
              <p className="text-xs text-ink-2">The Vault owns everything and is the only place value can leave to. The Operator can only place, trim and exit ranges inside these caps:</p>
              <dl className="divide-y divide-[var(--grid)] text-sm">
                {capsRows(DEFAULT_CAPS).map((r) => (
                  <div key={r.label} className="flex justify-between gap-3 py-1.5" title={r.note}>
                    <dt className="text-ink-2">{r.label}</dt>
                    <dd className="text-right font-semibold">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </aside>
        </div>
      )}
    </div>
  );
}

function OpenLink({ lane }: { lane: Address }) {
  return (
    <Link href={`/desk/${lane}`} className="inline-flex min-h-10 items-center rounded-lg bg-surface-2 px-4 text-sm font-medium hover:bg-[var(--grid)]">
      Open
    </Link>
  );
}

/**
 * lanesOf(Vault) split into lanes this setup could have made (owner is the Vault; operator is one of this account's
 * wallets, the Plan B server wallet or revoked; guardian is DeltaDesk's watchdog or none) and the rest, with why.
 */
function useYourDesks(lanes: readonly Address[], vault: Address | null, session: DeskSession, operator: Address | null) {
  const key = lanes.join(",");
  const roles = usePoll(lanes.length ? () => readLaneRoles(lanes) : null, 30_000, `roles:${key}`);
  const planB = usePoll(lanes.length ? () => deskApi<{ address?: string }>("/operator-address") : null, 300_000, `planb:${lanes.length > 0}`);
  const planBAddr = planB.data?.ok && planB.data.data.address && isAddress(planB.data.data.address) ? planB.data.data.address : null;
  const operators = [operator, planBAddr, ...session.others.map((w) => w.address)];
  const why = (r: LaneRoles): string | null => {
    if (!r.owner || !r.operator || !r.guardian) return "Could not read its roles from the chain.";
    if (!same(r.owner, vault)) return `Owner ${short(r.owner)} is not your Vault.`;
    if (!isZeroAddr(r.operator) && !operators.some((o) => same(o, r.operator))) return `Operator ${short(r.operator)} is not one of your wallets.`;
    if (!isZeroAddr(r.guardian) && !same(r.guardian, DESK_GUARDIAN)) return `Guardian ${short(r.guardian)} is not DeltaDesk's watchdog.`;
    return null;
  };
  const checked = roles.data?.map((r) => ({ lane: r.lane, why: why(r) })) ?? [];
  return {
    checked: !!roles.data,
    error: roles.error,
    mine: checked.filter((c) => !c.why).map((c) => c.lane),
    other: checked.filter((c): c is { lane: Address; why: string } => !!c.why),
  };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Step({ n, title, state, summary, children }: { n: number; title: string; state: "done" | "active" | "locked"; summary: ReactNode; children: ReactNode }) {
  const disc =
    state === "done" ? (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--good)] text-sm font-bold text-black" aria-label="done">
        ✓
      </span>
    ) : (
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${state === "active" ? "bg-[var(--accent)] text-white" : "bg-surface-2 text-muted"}`}
        aria-hidden
      >
        {n}
      </span>
    );
  return (
    <li className={`card p-4 ${state === "active" ? "ring-2 ring-[var(--accent)]" : ""}`} aria-current={state === "active" ? "step" : undefined}>
      <div className="flex items-start gap-3">
        {disc}
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className={`font-semibold ${state === "locked" ? "text-muted" : ""}`}>{title}</h3>
            {summary && <div className="min-w-0 text-sm">{summary}</div>}
          </div>
          {children}
        </div>
      </div>
    </li>
  );
}

function SignInStep({ session }: { session: DeskSession }) {
  const action = useAction();
  const slow = useSlow(!session.sdkHasLoaded);
  if (!session.sdkHasLoaded) return slow ? <Status tone="warning">{DYNAMIC_SLOW_HINT}</Status> : <p className="text-sm text-ink-2">Loading Dynamic…</p>;
  if (!session.loggedIn)
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-2">Sign in with your email. Dynamic creates an embedded wallet for you: that is your <strong>Vault</strong>, the owner of the desk. It is never delegated and only needs a little gas.</p>
        <Btn kind="primary" onClick={session.signIn}>
          Sign in with email
        </Btn>
      </div>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">Signed in{session.email ? ` as ${session.email}` : ""}, but this account has no embedded EVM wallet yet.</p>
      <Btn kind="primary" disabled={action.busy} onClick={() => action.run("Creating your Vault wallet…", session.createVault)}>
        Create Vault wallet
      </Btn>
      <TxLine state={action.state} />
    </div>
  );
}

function OperatorStep({ session, vault, onPick }: { session: DeskSession; vault: Address | null; onPick: (a: Address, kind: "embedded" | "server") => void }) {
  const action = useAction();
  const [planB, setPlanB] = useState(false);
  const create = () =>
    action.run("Creating the Operator wallet…", async () => {
      try {
        onPick(await session.createOperator(), "embedded");
      } catch (e) {
        setPlanB(true);
        throw e;
      }
    });
  const serverWallet = () =>
    action.run("Fetching DeltaDesk's server wallet…", async () => {
      const r = await deskApi<{ address?: string }>("/operator-address");
      if (!r.ok) throw new Error(`desk-agent: ${r.error}`);
      const a = r.data.address;
      if (!a || !isAddress(a)) throw new Error("desk-agent returned no operator address.");
      if (vault && a.toLowerCase() === vault.toLowerCase()) throw new Error("The Operator can't be the Vault.");
      onPick(getAddress(a), "server");
    });
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        A second embedded wallet that the agent signs with. On-chain it can only place, trim, collect and exit ranges inside your caps, or pause. It can never withdraw, unpause or change settings.
      </p>
      {session.others.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted">Existing embedded wallets on this account</div>
          {session.others.map((w) => (
            <div key={w.address} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-2">
              <Addr address={w.address} />
              <Btn onClick={() => onPick(getAddress(w.address), "embedded")}>Use as Operator</Btn>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Btn kind="primary" disabled={action.busy} onClick={create}>
          Create Operator wallet
        </Btn>
        <Btn kind={planB ? "secondary" : "ghost"} disabled={action.busy} onClick={serverWallet}>
          Use DeltaDesk&apos;s server wallet (Plan B)
        </Btn>
      </div>
      {planB && <p className="text-xs text-ink-2">If this Dynamic environment allows only one embedded wallet per user, use Plan B: a DeltaDesk-held 2-of-2 server wallet becomes the Operator. Your Vault still owns the lane.</p>}
      <TxLine state={action.state} />
    </div>
  );
}

function GasStep({ vault, operator, vaultEth, operatorEth, onSkip }: { vault: Address | null; operator: Address | null; vaultEth?: bigint; operatorEth?: bigint; onSkip: () => void }) {
  const rows = [
    { label: "Vault", addr: vault, bal: vaultEth, need: GAS_TARGET_WEI.vault, why: "pays for creating the lane and your owner controls" },
    { label: "Operator", addr: operator, bal: operatorEth, need: GAS_TARGET_WEI.operator, why: "pays for the agent's reranges and exits" },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">Send a little ETH on Robinhood Chain (chain {CHAIN_ID}) to both wallets. Gas is cheap (a full rerange is about $0.10–0.90); balances refresh every 4 s.</p>
      {rows.map((r) => {
        const ok = r.bal != null && r.bal >= r.need;
        return (
          <div key={r.label} className="space-y-2 rounded-lg bg-surface-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">{r.label}</div>
              {ok ? <Status tone="good">ready</Status> : <Status tone="warning">needs {fmtEth(r.need)}</Status>}
            </div>
            {r.addr && <Addr address={r.addr} full />}
            <div className="flex justify-between text-xs text-ink-2">
              <span>{r.why}</span>
              <span className="tabular">
                <strong className="text-ink">{fmtEth(r.bal)}</strong> / {fmtEth(r.need)}
              </span>
            </div>
            <Meter value={Number(r.bal ?? BigInt(0))} max={Number(r.need)} label={`${r.label} gas`} />
          </div>
        );
      })}
      <Btn kind="ghost" onClick={onSkip}>
        Continue anyway
      </Btn>
    </div>
  );
}

function PredictStep({
  owner,
  factory,
  factoryError,
  params,
  state,
  set,
}: {
  owner: Address | null;
  factory?: Awaited<ReturnType<typeof readFactory>>;
  factoryError: string | null;
  params: (salt: Hex) => CreateParams | null;
  state: WizardState;
  set: (p: Partial<WizardState>) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const ready = !!factory && !!factory.implementation && factory.poolAllowed;
  const over = factory?.ceilings ? capsAboveCeilings(DEFAULT_CAPS, factory.ceilings) : [];
  const nLanes = factory?.lanes.length ?? 0;
  const impl = factory?.implementation ?? null;
  const moved = state.moved;
  const replaced = state.replaced && !same(state.replaced, state.predicted) ? state.replaced : null;

  // Predicts once, then re-predicts whenever the factory's implementation changes: a stored prediction that no longer
  // matches is replaced and the policy acknowledgement cleared. After a move the lane already exists, so it stays put.
  useEffect(() => {
    if (!DESK_FACTORY || !ready || over.length || !owner || moved) return;
    let stop = false;
    const salt = state.salt ?? laneSalt(owner, nLanes);
    const p = params(salt);
    if (!p) return;
    predictLane(DESK_FACTORY, p)
      .then((predicted) => {
        if (stop) return;
        setErr(null);
        if (!state.predicted) set({ salt, predicted });
        // The allowlist still names the address the user last confirmed, if a re-prediction came before confirming.
        else if (!same(state.predicted, predicted)) set({ salt, predicted, policyAck: false, replaced: state.replaced ?? state.predicted });
      })
      .catch((e) => !stop && setErr(describeError(e)));
    return () => {
      stop = true;
    };
  }, [ready, over.length, state.predicted, state.salt, owner, nLanes, impl, moved]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!DESK_FACTORY) return <Status tone="warning">Not deployed yet: set NEXT_PUBLIC_DESK_FACTORY once DeskLaneFactory is live on chain {CHAIN_ID}.</Status>;
  if (!factory) return <p className="text-sm text-ink-2">{factoryError ? `Factory read failed: ${factoryError}` : "Reading the factory…"}</p>;
  if (!factory.implementation) return <Status tone="warning">The factory has no DeskLaneV3 implementation registered yet.</Status>;
  if (!factory.poolAllowed) return <Status tone="warning">The factory has not allowed the NVDA/USDG pool yet.</Status>;
  if (over.length) return <Status tone="critical">Default caps are looser than the factory allows: {over.join(", ")}.</Status>;
  if (factory.pending && !moved)
    return (
      <Notice tone="critical" title="Setup paused: the lane implementation is being replaced">
        {pendingText(factory.pending)}
      </Notice>
    );
  if (err) return <Status tone="critical">predictLane failed: {err}</Status>;
  if (!state.predicted) return <p className="text-sm text-ink-2">Predicting your lane address…</p>;
  return (
    <div className="space-y-3">
      {moved ? (
        <Notice tone="critical" title="Your lane was created at a different address">
          <div className="space-y-2">
            <p>
              createLane put your lane at <span className="break-all font-mono">{moved.to}</span>, not at the predicted{" "}
              <span className="break-all font-mono">{moved.from}</span> (the factory&apos;s lane implementation changed in between). The Dynamic policy allowlist you saved names
              the predicted address, so it no longer matches: the Operator&apos;s transactions to your lane would be refused, and the allowlist names a contract that is not
              your lane.
            </p>
            <p>
              Fix: in the policy, replace the old address with the new one as the only allowed destination, then confirm below. If you can&apos;t, do not delegate the
              Operator; <Link href={`/desk/${moved.to}`} className="underline">open the lane</Link> and withdraw instead.
            </p>
          </div>
        </Notice>
      ) : (
        <>
          {replaced && (
            <Notice tone="warning" title="The predicted address changed">
              The factory now predicts a new address for your lane (its lane implementation or the lane settings changed), instead of{" "}
              <span className="break-all font-mono">{replaced}</span>. Put the new address in the policy allowlist in place of the old one.
            </Notice>
          )}
          <p className="text-sm text-ink-2">
            Your lane will be deployed at exactly this address (the factory salt commits to every parameter, so nobody can deploy anything else there):
          </p>
        </>
      )}
      <div className="rounded-lg bg-surface-2 p-3">
        <Addr address={state.predicted} full />
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>In the Dynamic dashboard, open the delegated-access policy for this environment.</li>
        <li>Chain: {CHAIN_ID} only. Allowlist: this lane as the only allowed destination. Native value: 0.</li>
        <li>
          Turn on <code className="font-mono">blockExport</code>, so the Operator&apos;s key can never be exported. (Your Vault keeps its own export: that is your
          last-resort exit.)
        </li>
        <li>Save. The Operator&apos;s signatures are now refused for anything but this lane.</li>
      </ol>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={state.policyAck} onChange={(e) => set(e.target.checked ? { policyAck: true, replaced: null } : { policyAck: false })} />
        {moved ? (
          <span>
            I replaced the old address with <span className="font-mono">{short(moved.to)}</span> in the Operator&apos;s policy allowlist, and the policy has{" "}
            <code className="font-mono">blockExport</code> on.
          </span>
        ) : replaced ? (
          <span>
            I replaced <span className="font-mono">{short(replaced)}</span> with <span className="font-mono">{short(state.predicted)}</span> in the Operator&apos;s policy
            allowlist, with chain {CHAIN_ID}, value 0 and <code className="font-mono">blockExport</code> on.
          </span>
        ) : (
          <span>
            I added the lane address to the Operator&apos;s policy allowlist, with chain {CHAIN_ID}, value 0 and <code className="font-mono">blockExport</code> on.
          </span>
        )}
      </label>
    </div>
  );
}

function CreateStep({
  session,
  params,
  predicted,
  onCreated,
  onMoved,
  onRepredict,
  onRestart,
}: {
  session: DeskSession;
  params: CreateParams | null;
  predicted: Address | null;
  onCreated: (lane: Address) => void;
  onMoved: (from: Address, to: Address) => void;
  onRepredict: () => void;
  onRestart: () => void;
}) {
  const action = useAction();
  const factory = DESK_FACTORY;
  const pf = usePoll(factory && params && predicted ? () => preflight(factory, params, predicted) : null, 4000, `create:${factory}:${predicted}:${params?.operator}`);
  const verdict = pf.data && params && predicted ? judge(pf.data, params, predicted) : null;

  // Already created and listed (another tab, or an earlier visit) and verified: move on without a transaction.
  const ready = verdict?.kind === "ready";
  useEffect(() => {
    if (ready && predicted && !action.busy) onCreated(predicted);
  }, [ready, predicted, action.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = () =>
    action.run("Checking the lane address…", async (onHash, done) => {
      if (!session.vault || !params || !predicted || !factory) throw new Error("Missing Vault, parameters or factory.");
      // Re-checks right before signing (the poll above may be seconds old), then sends and verifies.
      const r = await createOrList(session.vault, factory, params, predicted, onHash);
      if (r.kind === "moved") {
        onMoved(predicted, r.lane);
        throw new Error(`Your lane was created at ${r.lane}, not at the predicted ${predicted}. Update the Operator's policy allowlist to the new address, or do not delegate.`);
      }
      onCreated(r.lane);
      done(
        r.kind === "ready"
          ? "Your lane already exists here and is listed for your Vault"
          : r.frontRun
            ? "The lane already deployed with your settings is now listed for your Vault and verified"
            : "Lane created, listed for your Vault and verified",
      );
    });

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Your Vault calls <code className="font-mono">createLane</code> on the factory with the caps on the right. The Vault becomes the immutable owner; the Operator gets only the agent role.
        Afterwards the wizard checks on-chain that the lane is listed for your Vault and that its owner, operator, guardian and caps are exactly these.
      </p>
      {!verdict ? (
        <p className="text-sm text-ink-2">{pf.error ? `Chain read failed: ${pf.error}` : "Checking the predicted address…"}</p>
      ) : verdict.kind === "ready" ? (
        <Status tone="good">Your lane already exists at the predicted address and is listed for your Vault. Continuing…</Status>
      ) : verdict.kind === "wrong" ? (
        <Notice tone="critical" title="This lane is not the one you asked for">
          <div className="space-y-2">
            <ul className="list-disc space-y-1 pl-5">
              {verdict.problems.map((p) => (
                <li key={p} className="break-words">
                  {p}
                </li>
              ))}
            </ul>
            <p>Setup stops here: do not delegate the Operator or fund this lane.</p>
            <div className="flex flex-wrap gap-2">
              <Btn onClick={onRestart}>Set up a new lane instead</Btn>
              {predicted && <OpenLink lane={predicted} />}
            </div>
          </div>
        </Notice>
      ) : verdict.kind === "blocked" ? (
        <Notice tone="critical" title="Lane creation is blocked">
          <div className="space-y-2">
            <p className="break-words">{verdict.reason}</p>
            {verdict.repredict && <Btn onClick={onRepredict}>Predict again</Btn>}
          </div>
        </Notice>
      ) : (
        verdict.frontRun && (
          <Notice tone="warning" title="A lane with your exact settings is already deployed here">
            Someone else deployed it (anyone may deploy a lane in your name, but only with exactly your parameters, which the address commits to). It is not in your desk list
            yet. Sending <code className="font-mono">createLane</code> from your Vault lists that lane for you; nothing new is deployed.
          </Notice>
        )
      )}
      <Btn kind="primary" disabled={action.busy || !params || verdict?.kind !== "create"} onClick={create}>
        {verdict?.kind === "create" && verdict.frontRun ? "List this lane from your Vault" : "Create lane from your Vault"}
      </Btn>
      <TxLine state={action.state} />
    </div>
  );
}

type AgentDelegation = {
  status: DelegationView["status"] | null;
  /** When desk-agent last changed its record (desk-agent's clock), or null. */
  updatedAtMs: number | null;
  error: string | null;
  /** desk-agent still has "revoked", but recorded before this delegation: the new one's webhook may yet arrive. */
  stale: boolean;
  timedOut: boolean;
  waitedMs: number;
};

function readDelegation(r: AgentResult<DelegationView>, operator: Address): Pick<AgentDelegation, "status" | "updatedAtMs" | "error"> {
  if (!r.ok) {
    const error =
      r.status === 401 || r.status === 403
        ? `desk-agent refused this sign-in for the Operator (${r.error})`
        : r.status === 404
          ? "desk-agent has no delegation lookup (it needs updating)"
          : `desk-agent: ${r.error}`;
    return { status: null, updatedAtMs: null, error };
  }
  const d = r.data;
  if (!same(d.operator, operator)) return { status: null, updatedAtMs: null, error: "desk-agent answered for a different address" };
  if (d.status !== "active" && d.status !== "revoked" && d.status !== "unknown")
    return { status: null, updatedAtMs: null, error: `desk-agent returned an unknown status (${String(d.status)})` };
  return { status: d.status, updatedAtMs: typeof d.updatedAtMs === "number" ? d.updatedAtMs : null, error: null };
}

/**
 * Polls desk-agent's record of `operator`'s delegation every DELEGATION_POLL_MS for up to DELEGATION_WAIT_MS, while
 * `operator` is non-null (the caller passes it only once Dynamic reports the Operator delegated). Stops on "active"
 * (calls `onActive`), on a "revoked" that describes this delegation, or on timeout; `retry` starts a fresh window.
 *
 * `fresh`: Dynamic was seen switching the Operator to delegated during this visit, so desk-agent may still hold the
 * previous delegation's "revoked" row until the new delegation's webhook lands. Then "revoked" counts only when
 * desk-agent recorded it after this window began; an older one keeps the poll going (`stale`) and is shown as revoked
 * only if it is still there when the wait runs out. Without `fresh` (Dynamic already showed the Operator delegated when
 * the step opened) there is no newer delegation to wait for, and "revoked" is final at once.
 */
function useAgentDelegation(operator: Address | null, fresh: boolean, jwt: () => string | null, onActive: (op: Address) => void) {
  const [round, setRound] = useState(0);
  const [view, setView] = useState<(AgentDelegation & { key: string }) | null>(null);
  const onActiveRef = useRef(onActive);
  useEffect(() => {
    onActiveRef.current = onActive;
  });
  const key = `${operator ?? "-"}:${round}`;

  useEffect(() => {
    if (!operator) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      const r = await deskApi<DelegationView>(`/delegations/${operator}`, { jwt: jwt() });
      if (stop) return;
      const v = readDelegation(r, operator);
      const waitedMs = Date.now() - started;
      const revoked = v.status === "revoked" && (!fresh || (v.updatedAtMs != null && v.updatedAtMs > started + AGENT_CLOCK_SLACK_MS));
      const settled = v.status === "active" || revoked;
      const timedOut = !settled && waitedMs >= DELEGATION_WAIT_MS;
      const stale = v.status === "revoked" && !settled && !timedOut;
      setView({ key, ...v, stale, timedOut, waitedMs });
      if (v.status === "active") onActiveRef.current(operator);
      else if (!settled && !timedOut) timer = setTimeout(poll, DELEGATION_POLL_MS);
    };
    poll();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      setView(null); // a later window (re-delegation, retry) never shows this one's last answer
    };
  }, [operator, key, jwt, fresh]);

  const retry = useCallback(() => setRound((n) => n + 1), []);
  return { view: operator && view?.key === key ? view : null, retry };
}

function DelegateStep({ session, operator, kind, onConfirmed }: { session: DeskSession; operator: Address | null; kind: WizardState["operatorKind"]; onConfirmed: (op: Address) => void }) {
  const action = useAction();
  const opStatus = session.delegationOf(operator);
  const dynamicDelegated = kind === "embedded" && !!operator && opStatus === "delegated";
  // Whether Dynamic showed the Operator not delegated at some point while this step was open: a delegation seen after
  // that is a new one (derived from earlier renders, so it is state set during render rather than in an effect).
  const [sawUndelegated, setSawUndelegated] = useState(false);
  if (!sawUndelegated && kind === "embedded" && operator && session.sdkHasLoaded && opStatus !== "delegated") setSawUndelegated(true);
  const agent = useAgentDelegation(dynamicDelegated ? operator : null, sawUndelegated, session.jwt, onConfirmed);
  if (kind === "server") return <p className="text-sm text-ink-2">Plan B: DeltaDesk&apos;s server wallet is the Operator, so there is nothing to delegate.</p>;
  const vaultStatus = session.vault ? session.delegationOf(session.vault.address) : "unknown";
  const v = agent.view;
  const waiting = (d: AgentDelegation) => `waiting for Dynamic's webhook (${Math.round(d.waitedMs / 1000)} s)`;
  const agentLine: { tone: Tone; text: string } = !dynamicDelegated
    ? { tone: "neutral", text: "waits for the Operator's delegation in Dynamic" }
    : !v
      ? { tone: "neutral", text: "checking…" }
      : v.status === "active"
        ? { tone: "good", text: "key share received" }
        : v.stale
          ? { tone: "neutral", text: `${waiting(v)}; its record still shows the previous delegation as revoked` }
          : v.status === "revoked"
            ? { tone: "critical", text: "revoked" }
            : v.timedOut
              ? { tone: "warning", text: "no delegation received yet" }
              : { tone: "neutral", text: `${waiting(v)}${v.error ? `; last check: ${v.error}` : ""}` };
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Delegate <strong>only the Operator</strong> to DeltaDesk, so the agent can sign for it within the lane&apos;s limits. Your Vault is never delegated. The step completes once
        desk-agent confirms it received the Operator&apos;s key share through Dynamic&apos;s webhook.
      </p>
      {session.delegatedAccessEnabled === false && (
        <Notice tone="warning" title="Delegated access is off">
          Enable delegated access for embedded wallets in this Dynamic environment, then reload.
        </Notice>
      )}
      <ul className="space-y-1 text-sm">
        <li>
          <Status tone={opStatus === "delegated" ? "good" : "warning"}>Operator (Dynamic): {opStatus}</Status>
        </li>
        <li>
          <Status tone={vaultStatus === "delegated" ? "critical" : "good"}>Vault: {vaultStatus === "delegated" ? "delegated (revoke it!)" : "not delegated"}</Status>
        </li>
        <li>
          <Status tone={agentLine.tone}>desk-agent: {agentLine.text}</Status>
        </li>
      </ul>
      {v?.status === "revoked" && !v.stale && (
        <Notice tone="critical" title="desk-agent has this Operator's delegation as revoked">
          <div className="space-y-2">
            <p>
              Dynamic shows the Operator as delegated, but desk-agent&apos;s record says the delegation was revoked, so it holds no key share and cannot sign. Setup can&apos;t
              continue with this delegation. Revoke it in Dynamic, delegate the Operator again, and desk-agent is checked again automatically.
            </p>
            {v.timedOut && (
              <p>
                That record is older than your delegation: after {Math.round(DELEGATION_WAIT_MS / 60_000)} minutes, Dynamic&apos;s webhook for the new delegation still
                hasn&apos;t reached desk-agent. Check that desk-agent is running and that the webhook URL and secret in the Dynamic dashboard point at it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Btn
                kind="danger"
                disabled={action.busy || !operator}
                onClick={() => action.run("Revoking the Operator's delegation…", async () => void (operator && (await session.revokeDynamicDelegation(operator))))}
              >
                Revoke in Dynamic
              </Btn>
              <Btn onClick={agent.retry}>Check again</Btn>
            </div>
          </div>
        </Notice>
      )}
      {v?.timedOut && v.status !== "revoked" && (
        <Notice tone="warning" title="desk-agent hasn't received the delegation">
          <div className="space-y-2">
            <p>
              After {Math.round(DELEGATION_WAIT_MS / 60_000)} minutes desk-agent still has no delegation for this Operator. The key share reaches DeltaDesk only through
              Dynamic&apos;s delegation webhook, so the agent can&apos;t sign yet. Check that desk-agent is running and that the webhook URL and secret in the Dynamic dashboard
              point at it, then retry.{v.error ? ` Last check: ${v.error}.` : ""}
            </p>
            <Btn onClick={agent.retry}>Retry</Btn>
          </div>
        </Notice>
      )}
      <Btn kind="primary" disabled={action.busy || !operator || opStatus === "delegated"} onClick={() => action.run("Delegating the Operator…", async () => operator && session.delegateOnly(operator))}>
        Delegate the Operator only
      </Btn>
      <TxLine state={action.state} />
    </div>
  );
}

function FundStep({ lane, onDone }: { lane: Address | null; onDone: () => void }) {
  const bal = usePoll(
    lane
      ? async () => {
          const [b, p] = await Promise.all([readTokenBalances(lane), readPrices()]);
          return { ...b, ...p };
        }
      : null,
    5000,
    `fund:${lane}`,
  );
  if (!lane) return null;
  const d = bal.data;
  const value = d && d.nvdaUsd != null && d.usdgUsd != null ? (Number(d.bal0) / 10 ** LANE_A.dec0) * d.usdgUsd + (Number(d.bal1) / 10 ** LANE_A.dec1) * d.nvdaUsd : null;
  const cap = Number(DEFAULT_CAPS.maxDeployUsd6) / 1e6;
  const funded = !!d && (d.bal0 > BigInt(0) || d.bal1 > BigInt(0));
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Send USDG and NVDA on Robinhood Chain straight to the lane, from any wallet. About ${FUND_TARGET_USD} is the plan for the first live mint; one rerange deploys at most ${cap}. No swaps
        happen in M2, so send both tokens for a two-sided range.
      </p>
      <div className="rounded-lg bg-surface-2 p-3">
        <Addr address={lane} full />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted">{LANE_A.sym0}</dt>
          <dd className="tabular font-semibold">{d ? fmtUnits(d.bal0, LANE_A.dec0, 2) : "–"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{LANE_A.sym1}</dt>
          <dd className="tabular font-semibold">{d ? fmtUnits(d.bal1, LANE_A.dec1, 5) : "–"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Value (Chainlink)</dt>
          <dd className="tabular font-semibold">{fmtUsd(value)}</dd>
        </div>
      </dl>
      <Meter value={value ?? 0} max={FUND_TARGET_USD} tone={value != null && value > cap ? "warning" : undefined} label="Lane funding toward the first mint" />
      {value != null && value > cap && <p className="text-xs text-ink-2">Above the ${cap} deploy cap: the agent will place at most ${cap} per rerange.</p>}
      <div className="flex flex-wrap gap-2">
        <Btn kind={funded ? "primary" : "ghost"} onClick={onDone}>
          {funded ? "Continue" : "Skip for now"}
        </Btn>
      </div>
    </div>
  );
}

function RegisterStep({
  session,
  lane,
  onRegistered,
  onDelegationLost,
}: {
  session: DeskSession;
  lane: Address | null;
  onRegistered: () => void;
  /** desk-agent holds no active delegation for the Operator (e.g. it dropped an unclaimed one): step 6 must run again. */
  onDelegationLost: () => void;
}) {
  const action = useAction();
  const [registered, setRegistered] = useState(false);
  if (!lane) return null;
  const register = () =>
    action.run("Registering with desk-agent…", async (_h, done) => {
      const r = await deskApi("/register", { method: "POST", body: { lane, chainId: CHAIN_ID }, jwt: session.jwt() });
      // The other 412 ("not this agent's wallet", a Plan B lane on a differently configured agent) is not about step 6.
      if (!r.ok && r.status === 412 && /no active delegation/i.test(r.error)) {
        onDelegationLost();
        throw new Error(`desk-agent: ${r.error}. Delegate the Operator again (step 6).`);
      }
      if (!r.ok && r.status !== 409) throw new Error(`desk-agent: ${r.error}`);
      setRegistered(true);
      done(r.ok ? "Registered" : "Already registered");
    });
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">desk-agent checks on-chain that the lane exists, that you own it and that the Operator is the wallet you delegated. Then choose how much it may do.</p>
      {!registered ? (
        <Btn kind="primary" disabled={action.busy} onClick={register}>
          Register desk
        </Btn>
      ) : (
        <div className="space-y-3">
          <ModePicker lane={lane} current="advisory" vault={session.vault} jwt={session.jwt} />
          <Btn kind="primary" onClick={onRegistered}>
            Finish
          </Btn>
        </div>
      )}
      <TxLine state={action.state} />
    </div>
  );
}
