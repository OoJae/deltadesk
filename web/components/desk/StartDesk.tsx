"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address, type Hash, type Hex } from "viem";
import { Button } from "@/components/brand/Button";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
import { Serial } from "@/components/brand/Serial";
import { StampMark } from "@/components/brand/StampToast";
import { CHAIN_SERIAL } from "@/components/brand/tokens";
import { deskApi } from "@/lib/desk/api";
import { DEFAULT_CAPS, capsRows } from "@/lib/desk/caps";
import { CHAIN_ID, KIND_V3_LP, LANE_A, addressUrl, txUrl } from "@/lib/desk/chain";
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
import { useDeskStamp } from "./stamp";
import { Addr, Blank, Btn, Card, Field, Meter, Notice, Pending, Status, StatusIcon, TxLine, type Tone } from "./ui";
import VaultAlarm from "./VaultAlarm";

/** Body copy inside a step: paper-dim, a readable measure. */
const P = "max-w-[68ch] text-[0.95rem] leading-relaxed text-paper-dim [&_strong]:font-medium [&_strong]:text-paper";
const CODE = "font-mono text-[0.88em] text-paper";

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
        Set <code className={CODE}>NEXT_PUBLIC_DYNAMIC_ENV_ID</code> to the Dynamic sandbox environment id and rebuild. Sign-in, the Vault and the Operator wallets all come from
        Dynamic&apos;s embedded wallets. Existing desks can still be viewed read-only at <code className={CODE}>/desk/&lt;lane address&gt;</code>.
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
  const { stamp } = useDeskStamp();

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
        return (
          <DelegateStep
            session={session}
            operator={operator}
            kind={S.operatorKind}
            onConfirmed={(op) => {
              const fresh = !same(S.agentDelegation, op);
              set({ agentDelegation: op });
              if (fresh) stamp({ kind: "signed", title: "Delegation confirmed", detail: `desk-agent holds the Operator's key share · ${short(op)}`, serial: op, href: addressUrl(op) });
            }}
          />
        );
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
            <Addr address={operator} /> <span className="text-xs text-paper-mute">{S.operatorKind === "server" ? "DeltaDesk server wallet (Plan B)" : "embedded wallet"}</span>
          </>
        );
      case 2:
        return <span className="font-mono text-[0.8rem] tabular text-paper-dim">Vault {fmtEth(vaultEth)} · Operator {fmtEth(operatorEth)}</span>;
      case 3:
      case 4:
        return S.predicted && <Addr address={S.lane ?? S.predicted} />;
      case 5:
        return <span className="text-paper-dim">{S.operatorKind === "server" ? "not needed (Plan B)" : "Operator delegated and confirmed by desk-agent; Vault not delegated"}</span>;
      case 6:
        return <span className="text-paper-dim">funded</span>;
      case 7:
        return <span className="text-paper-dim">registered</span>;
    }
  };

  const lanes = factory.data?.lanes ?? [];
  const desks = useYourDesks(lanes, vaultAddr, session, operator);
  // VaultAlarm explains why: with these settings on, Dynamic may offer to delegate the Vault, so no setup step runs.
  const blocked = session.unsafeDelegationSettings.length > 0;
  const complete = active === -1;
  return (
    <div className="space-y-6">
      <VaultAlarm session={session} />
      {!DESK_FACTORY && !blocked && (
        <Notice tone="warning" title="Lane factory not deployed yet">
          <code className={CODE}>NEXT_PUBLIC_DESK_FACTORY</code> is unset. You can sign in, create the Operator and top up gas now; lane creation unlocks once the factory is deployed on
          Robinhood Chain.
        </Notice>
      )}
      {lanes.length > 0 && (
        <Card title="Your desks" label="Listed by the factory for your Vault">
          {!desks.checked ? (
            <p className="text-sm text-paper-dim">{desks.error ? `Could not check your desks on-chain: ${desks.error}` : "Checking your desks on-chain…"}</p>
          ) : (
            <>
              {desks.mine.length > 0 ? (
                <ul className="divide-y divide-rule border-y border-rule">
                  {desks.mine.map((l) => (
                    <li key={l} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <Addr address={l} />
                      <div className="flex items-center gap-4">
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
                <p className="text-sm text-paper-dim">None of the lanes listed for your Vault has the roles this setup uses.</p>
              )}
              {desks.other.length > 0 && (
                <details className="group border border-rule bg-vault text-sm">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 font-medium text-paper [&::-webkit-details-marker]:hidden">
                    <span>
                      {desks.other.length} other lane{desks.other.length > 1 ? "s" : ""} listed for your Vault
                    </span>
                    <span aria-hidden className="font-mono text-paper-mute transition-transform duration-300 ease-out group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <div className="border-t border-rule px-3.5 pb-1">
                    <p className="mt-3 text-paper-dim">
                      Your Vault listed these, but their owner, operator or guardian is not what this setup uses, so setup can&apos;t continue on them. Open one to review it
                      or withdraw.
                    </p>
                    <ul className="mt-2 divide-y divide-rule">
                      {desks.other.map((o) => (
                        <li key={o.lane} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                          <div className="min-w-0 space-y-1">
                            <Addr address={o.lane} />
                            <div className="text-xs text-paper-dim">{o.why}</div>
                          </div>
                          <OpenLink lane={o.lane} />
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              )}
            </>
          )}
          {resumeNote && <Status tone="warning">{resumeNote}</Status>}
        </Card>
      )}

      {!blocked && (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)] xl:gap-16">
          <div className="min-w-0 space-y-6">
            <ol aria-label="Setup, eight steps in order" className="border-b border-rule">
              {STEPS.map((title, i) => {
                const state = complete || i < active ? "done" : i === active ? "active" : "locked";
                return (
                  <Step key={title} n={i + 1} of={STEPS.length} title={title} state={state} summary={state === "done" ? summary(i) : null}>
                    {state === "active" && stepBody(i)}
                  </Step>
                );
              })}
            </ol>
            {complete && S.lane && (
              <Card label="All eight steps done">
                <Status tone="good">Your desk is set up.</Status>
                <div>
                  <Button href={`/desk/${S.lane}`} prefetch={false} trailing="→">
                    Open your desk
                  </Button>
                </div>
              </Card>
            )}
          </div>

          <aside className="lg:sticky lg:top-24 lg:self-start">
            <Certificate vault={vaultAddr} operator={operator} lane={S.lane ?? S.predicted} issued={complete && S.lane ? S.lane : null} />
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * The aside is the certificate being filled in: every blank takes its value as the steps complete, and the finished
 * desk is stamped "issued". Values are the same facts the old summary card listed.
 */
function Certificate({ vault, operator, lane, issued }: { vault: Address | null; operator: Address | null; lane: Address | null; issued: Address | null }) {
  return (
    <section aria-labelledby="desk-certificate" className="relative border border-rule bg-vault-2">
      <Guilloche variant="border" width={12} opacity={0.38} />
      <div className="relative space-y-7 px-6 py-8 sm:px-8 sm:py-9">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Label as="p">What you are creating</Label>
            <Serial n={CHAIN_SERIAL} className="text-[0.72rem]" />
          </div>
          <h2 id="desk-certificate" className="font-display text-[1.7rem] leading-[1.08] tracking-[-0.01em] text-paper">
            This certifies that your <em>Vault</em> owns the lane.
          </h2>
        </div>
        <dl className="space-y-3.5">
          <Blank label="Vault (owner)">{vault ? <Addr address={vault} /> : <Pending>sign in</Pending>}</Blank>
          <Blank label="Operator (agent)">{operator ? <Addr address={operator} /> : <Pending>step 2</Pending>}</Blank>
          <Blank label="Lane">{lane ? <Addr address={lane} /> : <Pending>step 4</Pending>}</Blank>
          <Blank label="Guardian">{isZeroAddr(DESK_GUARDIAN) ? <span className="text-sm text-paper-dim">none</span> : <Addr address={DESK_GUARDIAN} />}</Blank>
          <Blank label="Pool">
            <span className="font-mono text-[0.85rem] text-paper">NVDA/USDG 0.05%</span>
          </Blank>
        </dl>
        <div className="space-y-3">
          <p className="text-[0.82rem] leading-relaxed text-paper-dim">
            The Vault owns everything and is the only place value can leave to. The Operator can only place, trim and exit ranges inside these caps:
          </p>
          <dl className="border-t border-rule-strong">
            {capsRows(DEFAULT_CAPS).map((r) => (
              <div key={r.label} className="flex justify-between gap-3 border-b border-rule py-2 text-[0.85rem]" title={r.note}>
                <dt className="text-paper-dim">{r.label}</dt>
                <dd className="text-right font-mono tabular text-paper">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        {issued && (
          <div className="flex items-center justify-end gap-3">
            <Label tone="dim">Issued on Robinhood Chain</Label>
            <div className="dd-stamp-enter">
              <StampMark word="ISSUED" serial={short(issued)} size={92} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function OpenLink({ lane }: { lane: Address }) {
  return (
    <Button href={`/desk/${lane}`} prefetch={false} variant="ghost" size="sm" trailing="→">
      Open
    </Button>
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

/**
 * One clause of the setup ledger. The numbers are a true sequence (each step needs the one before), so they carry the
 * certificate's "N°". Done and locked clauses are single ruled lines (done ones show the value they filled in); the
 * active clause lifts into a raised panel: its N° in serial red, a restrained Bodoni title, and the step's controls.
 */
function Step({ n, of, title, state, summary, children }: { n: number; of: number; title: string; state: "done" | "active" | "locked"; summary: ReactNode; children: ReactNode }) {
  if (state !== "active")
    return (
      <li className="grid grid-cols-[3.4rem_minmax(0,1fr)] items-baseline gap-x-3 border-t border-rule py-4 sm:grid-cols-[4.25rem_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-1">
        <Serial n={n} pad={2} tone="dim" className="text-[0.75rem]" style={state === "locked" ? { color: "var(--paper-mute)" } : undefined} />
        <h3 className={`font-display text-[1.2rem] leading-tight ${state === "locked" ? "text-paper-mute" : "text-paper-dim"}`}>{title}</h3>
        {state === "done" && (
          <div className="col-start-2 mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:col-start-3 sm:mt-0 sm:justify-end">
            {summary && <div className="min-w-0">{summary}</div>}
            <span className="inline-flex items-center gap-1.5">
              <StatusIcon tone="good" size={14} />
              <span className="label text-paper-mute">Done</span>
            </span>
          </div>
        )}
      </li>
    );
  return (
    <li aria-current="step" className="my-4 border border-rule-strong bg-vault-2 first:mt-0 last:mb-0">
      <div className="grid grid-cols-[3.4rem_minmax(0,1fr)] gap-x-3 px-4 py-5 sm:grid-cols-[4.25rem_minmax(0,1fr)] sm:gap-x-4 sm:px-6 sm:py-7">
        <div className="pt-[0.55rem]">
          <Serial n={n} pad={2} className="text-[0.8rem]" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label as="p">
            Current step · {n} of {of}
          </Label>
          <h3 className="font-display text-title text-balance text-paper">{title}</h3>
        </div>
        <div className="col-span-2 mt-5 animate-[dd-rise_0.8s_var(--ease-out)_both] border-t border-rule pt-5 sm:col-span-1 sm:col-start-2 sm:mt-6 sm:pt-6">
          {children}
        </div>
      </div>
    </li>
  );
}

function SignInStep({ session }: { session: DeskSession }) {
  const action = useAction();
  const slow = useSlow(!session.sdkHasLoaded);
  if (!session.sdkHasLoaded) return slow ? <Status tone="warning">{DYNAMIC_SLOW_HINT}</Status> : <p className={P}>Loading Dynamic…</p>;
  if (!session.loggedIn)
    return (
      <div className="space-y-5">
        <p className={P}>Sign in with your email. Dynamic creates an embedded wallet for you: that is your <strong>Vault</strong>, the owner of the desk. It is never delegated and only needs a little gas.</p>
        <Btn kind="primary" onClick={session.signIn}>
          Sign in with email
        </Btn>
        <p className="max-w-[68ch] text-[0.82rem] leading-relaxed text-paper-dim">
          Dynamic&apos;s widget is on their <strong>sandbox</strong> environment, so it shows a Sandbox badge. Only the sign-in environment is a sandbox: the Vault and the
          Operator are real embedded wallets, the delegation is real, and every transaction is real and lands on Robinhood Chain {CHAIN_ID} — including the lane, the funding
          and the agent&apos;s signals linked from the README.
        </p>
      </div>
    );
  return (
    <div className="space-y-5">
      <p className={P}>Signed in{session.email ? ` as ${session.email}` : ""}, but this account has no embedded EVM wallet yet.</p>
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
  // Plan B only exists when this deployment's desk-agent holds a Dynamic server wallet. Probe once, so we never offer
  // a button that can only fail (the route answers 404 "no server-wallet operator is configured" when it is unset).
  const planBProbe = usePoll(() => deskApi<{ address?: string }>("/operator-address"), 300_000, "planb:probe");
  const planBProbed = planBProbe.data !== undefined || planBProbe.error !== null;
  const planBOffered = planBProbe.data?.ok === true;
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
    <div className="space-y-5">
      <p className={P}>
        A second embedded wallet that the agent signs with. On-chain it can only place, trim, collect and exit ranges inside your caps, or pause. It can never withdraw, unpause or change settings.
      </p>
      {session.others.length > 0 && (
        <div className="space-y-2">
          <Label as="div">Existing embedded wallets on this account</Label>
          {session.others.map((w) => (
            <div key={w.address} className="flex flex-wrap items-center justify-between gap-2 border border-rule bg-vault py-2 pr-2 pl-3.5">
              <Addr address={w.address} />
              <Btn size="sm" onClick={() => onPick(getAddress(w.address), "embedded")}>
                Use as Operator
              </Btn>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Btn kind="primary" disabled={action.busy} onClick={create}>
          Create Operator wallet
        </Btn>
        {planBOffered && (
          <Btn kind={planB ? "secondary" : "ghost"} disabled={action.busy} onClick={serverWallet}>
            Use DeltaDesk&apos;s server wallet (Plan B)
          </Btn>
        )}
      </div>
      {planB && planBProbed && (
        <p className="max-w-[68ch] text-[0.82rem] leading-relaxed text-paper-dim">
          {planBOffered
            ? "If this Dynamic environment allows only one embedded wallet per user, use Plan B: a DeltaDesk-held 2-of-2 server wallet becomes the Operator. Your Vault still owns the lane."
            : "Plan B (a DeltaDesk-held server wallet as the Operator) is not configured on this deployment, so the Operator has to be a second embedded wallet on this account: pick one above, or retry. The desk that is already running can be read without signing in at /desk/<lane address>."}
        </p>
      )}
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
    <div className="space-y-5">
      <p className={P}>
        Send a little ETH on Robinhood Chain (chain <span className="font-mono">{CHAIN_ID}</span>) to both wallets. Gas is cheap (a full rerange is about $0.10–0.90); balances
        refresh every 4 s.
      </p>
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((r) => {
          const ok = r.bal != null && r.bal >= r.need;
          return (
            <Field key={r.label} label={r.label} aside={ok ? <Status tone="good">ready</Status> : <Status tone="warning">needs {fmtEth(r.need)}</Status>}>
              {r.addr && <Addr address={r.addr} full />}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-paper-dim">
                <span>{r.why}</span>
                <span className="font-mono tabular">
                  <strong className="font-medium text-paper">{fmtEth(r.bal)}</strong> / {fmtEth(r.need)}
                </span>
              </div>
              <Meter value={Number(r.bal ?? BigInt(0))} max={Number(r.need)} label={`${r.label} gas`} />
            </Field>
          );
        })}
      </div>
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
  if (!factory) return <p className={P}>{factoryError ? `Factory read failed: ${factoryError}` : "Reading the factory…"}</p>;
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
  if (!state.predicted) return <p className={P}>Predicting your lane address…</p>;
  return (
    <div className="space-y-5">
      {moved ? (
        <Notice tone="critical" title="Your lane was created at a different address">
          <div className="space-y-2">
            <p>
              createLane put your lane at <span className="break-all font-mono text-paper">{moved.to}</span>, not at the predicted{" "}
              <span className="break-all font-mono text-paper">{moved.from}</span> (the factory&apos;s lane implementation changed in between). The Dynamic policy allowlist you
              saved names the predicted address, so it no longer matches: the Operator&apos;s transactions to your lane would be refused, and the allowlist names a contract that
              is not your lane.
            </p>
            <p>
              Fix: in the policy, replace the old address with the new one as the only allowed destination, then confirm below. If you can&apos;t, do not delegate the
              Operator;{" "}
              <Link href={`/desk/${moved.to}`} prefetch={false} className="text-paper underline decoration-rule-strong underline-offset-4 hover:decoration-paper">
                open the lane
              </Link>{" "}
              and withdraw instead.
            </p>
          </div>
        </Notice>
      ) : (
        <>
          {replaced && (
            <Notice tone="warning" title="The predicted address changed">
              The factory now predicts a new address for your lane (its lane implementation or the lane settings changed), instead of{" "}
              <span className="break-all font-mono text-paper">{replaced}</span>. Put the new address in the policy allowlist in place of the old one.
            </Notice>
          )}
          <p className={P}>Your lane will be deployed at exactly this address (the factory salt commits to every parameter, so nobody can deploy anything else there):</p>
        </>
      )}
      <Field label="Your lane's address" aside={<Label tone="dim">chain {CHAIN_ID}</Label>}>
        <Addr address={state.predicted} full />
      </Field>
      <div className="space-y-3">
        <Label as="p">In the Dynamic dashboard</Label>
        <ol className="border-t border-rule text-[0.9rem] leading-relaxed text-paper-dim">
          {[
            <>Open the delegated-access policy for this environment.</>,
            <>
              Chain: <span className="font-mono text-paper">{CHAIN_ID}</span> only. Allowlist: this lane as the only allowed destination. Native value:{" "}
              <span className="font-mono text-paper">0</span>.
            </>,
            <>
              Turn on <code className={CODE}>blockExport</code>, so the Operator&apos;s key can never be exported. (Your Vault keeps its own export: that is your last-resort
              exit.)
            </>,
            <>Save. The Operator&apos;s signatures are now refused for anything but this lane.</>,
          ].map((item, i) => (
            <li key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 border-b border-rule py-2.5">
              <span aria-hidden className="font-mono text-[0.8rem] leading-[1.6rem] text-paper-mute">
                {i + 1}.
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </div>
      <label
        className={`flex cursor-pointer items-start gap-3 border px-4 py-3.5 text-[0.9rem] leading-relaxed transition-colors ${state.policyAck ? "border-paper-dim bg-vault-3 text-paper" : "border-rule-strong bg-vault text-paper-dim hover:border-paper-dim"}`}
      >
        <input
          type="checkbox"
          className="mt-[0.2rem] h-4 w-4 shrink-0 cursor-pointer accent-[var(--paper)]"
          checked={state.policyAck}
          onChange={(e) => set(e.target.checked ? { policyAck: true, replaced: null } : { policyAck: false })}
        />
        {moved ? (
          <span>
            I replaced the old address with <span className="font-mono text-paper">{short(moved.to)}</span> in the Operator&apos;s policy allowlist, and the policy has{" "}
            <code className={CODE}>blockExport</code> on.
          </span>
        ) : replaced ? (
          <span>
            I replaced <span className="font-mono text-paper">{short(replaced)}</span> with <span className="font-mono text-paper">{short(state.predicted)}</span> in the
            Operator&apos;s policy allowlist, with chain {CHAIN_ID}, value 0 and <code className={CODE}>blockExport</code> on.
          </span>
        ) : (
          <span>
            I added the lane address to the Operator&apos;s policy allowlist, with chain {CHAIN_ID}, value 0 and <code className={CODE}>blockExport</code> on.
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
  const { stamp } = useDeskStamp();
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
      const sent: { hash?: Hash } = {};
      const r = await createOrList(session.vault, factory, params, predicted, (h) => {
        sent.hash = h;
        onHash(h);
      });
      if (r.kind === "moved") {
        onMoved(predicted, r.lane);
        throw new Error(`Your lane was created at ${r.lane}, not at the predicted ${predicted}. Update the Operator's policy allowlist to the new address, or do not delegate.`);
      }
      onCreated(r.lane);
      const note =
        r.kind === "ready"
          ? "Your lane already exists here and is listed for your Vault"
          : r.frontRun
            ? "The lane already deployed with your settings is now listed for your Vault and verified"
            : "Lane created, listed for your Vault and verified";
      done(note);
      const tx = sent.hash;
      stamp({
        kind: "recorded",
        title: r.kind === "ready" ? "Lane already listed for your Vault" : r.frontRun ? "Lane listed for your Vault" : "Lane created",
        detail: `${short(r.lane)} · owner, operator, guardian and caps verified on-chain`,
        serial: tx ?? r.lane,
        href: tx ? txUrl(tx) : addressUrl(r.lane),
      });
    });

  return (
    <div className="space-y-5">
      <p className={P}>
        Your Vault calls <code className={CODE}>createLane</code> on the factory with the caps on the certificate. The Vault becomes the immutable owner; the Operator gets only
        the agent role. Afterwards the wizard checks on-chain that the lane is listed for your Vault and that its owner, operator, guardian and caps are exactly these.
      </p>
      {!verdict ? (
        <p className={P}>{pf.error ? `Chain read failed: ${pf.error}` : "Checking the predicted address…"}</p>
      ) : verdict.kind === "ready" ? (
        <Status tone="good">Your lane already exists at the predicted address and is listed for your Vault. Continuing…</Status>
      ) : verdict.kind === "wrong" ? (
        <Notice tone="critical" title="This lane is not the one you asked for">
          <div className="space-y-3">
            <ul className="space-y-1.5">
              {verdict.problems.map((p) => (
                <li key={p} className="grid grid-cols-[1rem_minmax(0,1fr)] break-words">
                  <span aria-hidden className="font-mono text-paper-mute">
                    ·
                  </span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
            <p>Setup stops here: do not delegate the Operator or fund this lane.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Btn onClick={onRestart}>Set up a new lane instead</Btn>
              {predicted && <OpenLink lane={predicted} />}
            </div>
          </div>
        </Notice>
      ) : verdict.kind === "blocked" ? (
        <Notice tone="critical" title="Lane creation is blocked">
          <div className="space-y-3">
            <p className="break-words">{verdict.reason}</p>
            {verdict.repredict && <Btn onClick={onRepredict}>Predict again</Btn>}
          </div>
        </Notice>
      ) : (
        verdict.frontRun && (
          <Notice tone="warning" title="A lane with your exact settings is already deployed here">
            Someone else deployed it (anyone may deploy a lane in your name, but only with exactly your parameters, which the address commits to). It is not in your desk list
            yet. Sending <code className={CODE}>createLane</code> from your Vault lists that lane for you; nothing new is deployed.
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
  if (kind === "server") return <p className={P}>Plan B: DeltaDesk&apos;s server wallet is the Operator, so there is nothing to delegate.</p>;
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
    <div className="space-y-5">
      <p className={P}>
        Delegate <strong>only the Operator</strong> to DeltaDesk, so the agent can sign for it within the lane&apos;s limits. Your Vault is never delegated. The step completes once
        desk-agent confirms it received the Operator&apos;s key share through Dynamic&apos;s webhook.
      </p>
      {session.delegatedAccessEnabled === false && (
        <Notice tone="warning" title="Delegated access is off">
          Enable delegated access for embedded wallets in this Dynamic environment, then reload.
        </Notice>
      )}
      <ul aria-label="Delegation status" className="border-y border-rule bg-vault">
        <li className="border-b border-rule px-3.5 py-2.5">
          <Status tone={opStatus === "delegated" ? "good" : "warning"}>Operator (Dynamic): {opStatus}</Status>
        </li>
        <li className="border-b border-rule px-3.5 py-2.5">
          <Status tone={vaultStatus === "delegated" ? "critical" : "good"}>Vault: {vaultStatus === "delegated" ? "delegated (revoke it!)" : "not delegated"}</Status>
        </li>
        <li className="px-3.5 py-2.5">
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
            <div className="flex flex-wrap items-center gap-3">
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
    <div className="space-y-5">
      <p className={P}>
        Send USDG and NVDA on Robinhood Chain straight to the lane, from any wallet. About ${FUND_TARGET_USD} is the plan for the first live mint; one rerange deploys at most ${cap}.
        No swaps happen in M2, so send both tokens for a two-sided range.
      </p>
      <Field label="Send to your lane" aside={<Label tone="dim">refreshes every 5 s</Label>}>
        <Addr address={lane} full />
      </Field>
      <dl className="grid grid-cols-3 border-y border-rule">
        {[
          { k: LANE_A.sym0, v: d ? fmtUnits(d.bal0, LANE_A.dec0, 2) : "–" },
          { k: LANE_A.sym1, v: d ? fmtUnits(d.bal1, LANE_A.dec1, 5) : "–" },
          { k: "Value (Chainlink)", v: fmtUsd(value) },
        ].map((x, i) => (
          <div key={x.k} className={`min-w-0 space-y-1.5 py-3 ${i ? "border-l border-rule pl-3 sm:pl-4" : ""}`}>
            <Label as="dt">{x.k}</Label>
            <dd className="truncate font-mono text-[1.15rem] tabular text-paper sm:text-[1.35rem]">{x.v}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <Meter value={value ?? 0} max={FUND_TARGET_USD} tone={value != null && value > cap ? "warning" : undefined} label="Lane funding toward the first mint" />
        <div className="flex justify-between font-mono text-[0.72rem] tabular text-paper-mute" aria-hidden>
          <span>$0</span>
          <span>${FUND_TARGET_USD} first mint</span>
        </div>
      </div>
      {value != null && value > cap && <p className="text-[0.82rem] text-paper-dim">Above the ${cap} deploy cap: the agent will place at most ${cap} per rerange.</p>}
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
  const { stamp } = useDeskStamp();
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
      stamp({ kind: "recorded", title: r.ok ? "Desk registered with desk-agent" : "Desk already registered", detail: `Lane ${short(lane)} · ownership and Operator checked on-chain`, serial: lane, href: addressUrl(lane) });
    });
  return (
    <div className="space-y-5">
      <p className={P}>desk-agent checks on-chain that the lane exists, that you own it and that the Operator is the wallet you delegated. Then choose how much it may do.</p>
      {!registered ? (
        <Btn kind="primary" disabled={action.busy} onClick={register}>
          Register desk
        </Btn>
      ) : (
        <div className="space-y-5">
          <Label as="p">How much the agent may do</Label>
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
