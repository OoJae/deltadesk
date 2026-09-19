"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { encodeFunctionData, getAddress, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { deskLaneFactoryAbi } from "@/lib/desk/abi/DeskLaneFactory";
import { deskApi } from "@/lib/desk/api";
import { DEFAULT_CAPS, capsRows } from "@/lib/desk/caps";
import { CHAIN_ID, KIND_V3_LP, LANE_A } from "@/lib/desk/chain";
import { DESK_FACTORY, DESK_GUARDIAN, GAS_TARGET_WEI } from "@/lib/desk/config";
import { fmtEth, fmtUnits, fmtUsd, isZeroAddr, short } from "@/lib/desk/format";
import { capsAboveCeilings, hasCode, laneSalt, predictLane, readEthBalances, readFactory, readLane, readPrices, readTokenBalances, type CreateParams } from "@/lib/desk/reads";
import { sendFromWallet } from "@/lib/desk/tx";
import type { DeskStatus } from "@/lib/desk/types";
import { useDeskSession } from "./context";
import { DYNAMIC_SLOW_HINT, useAction, usePoll, useSlow, useStoredState } from "./hooks";
import ModePicker from "./ModePicker";
import type { DeskSession } from "./session";
import { Addr, Btn, Card, Meter, Notice, Status, TxLine } from "./ui";
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
};
const INITIAL: WizardState = { operator: null, operatorKind: null, gasAck: false, salt: null, predicted: null, policyAck: false, lane: null, fundAck: false, registered: false };

const FUND_TARGET_USD = 50;
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
  const target = S.lane ?? S.predicted;
  const exists = usePoll(target ? () => hasCode(target) : null, 4000, `code:${target}`);

  // A lane that appeared at the predicted address (another tab, or a front-runner with our exact params) is ours.
  useEffect(() => {
    if (!S.lane && S.predicted && exists.data === true) set({ lane: S.predicted });
  }, [S.lane, S.predicted, exists.data, set]);

  const [vaultEth, operatorEth] = gas.data ?? [];
  const gasOk = vaultEth != null && operatorEth != null && vaultEth >= GAS_TARGET_WEI.vault && operatorEth >= GAS_TARGET_WEI.operator;
  useEffect(() => {
    if (gasOk && !S.gasAck && vaultAddr) set({ gasAck: true });
  }, [gasOk, S.gasAck, vaultAddr, set]);

  const delegated = S.operatorKind === "server" || (!!operator && session.delegationOf(operator) === "delegated");
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
        return <CreateStep session={session} params={S.salt ? params(S.salt) : null} predicted={S.predicted} onCreated={(lane) => set({ lane })} />;
      case 5:
        return <DelegateStep session={session} lane={S.lane} operator={operator} kind={S.operatorKind} />;
      case 6:
        return <FundStep lane={S.lane} onDone={() => set({ fundAck: true })} />;
      case 7:
        return <RegisterStep session={session} lane={S.lane} onRegistered={() => set({ registered: true })} />;
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
        return <span className="text-ink-2">{S.operatorKind === "server" ? "not needed (Plan B)" : "Operator delegated; Vault not delegated"}</span>;
      case 6:
        return <span className="text-ink-2">funded</span>;
      case 7:
        return <span className="text-ink-2">registered</span>;
    }
  };

  const lanes = factory.data?.lanes ?? [];
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
          <ul className="divide-y divide-[var(--grid)]">
            {lanes.map((l) => (
              <li key={l} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Addr address={l} />
                <div className="flex gap-2">
                  {!blocked && S.lane?.toLowerCase() !== l.toLowerCase() && (
                    <Btn kind="ghost" onClick={() => resume(l)}>
                      Continue setup
                    </Btn>
                  )}
                  <Link href={`/desk/${l}`} className="inline-flex min-h-10 items-center rounded-lg bg-surface-2 px-4 text-sm font-medium hover:bg-[var(--grid)]">
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
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

  useEffect(() => {
    if (!DESK_FACTORY || !ready || over.length || state.predicted || !owner) return;
    let stop = false;
    const salt = state.salt ?? laneSalt(owner, nLanes);
    const p = params(salt);
    if (!p) return;
    predictLane(DESK_FACTORY, p)
      .then((predicted) => !stop && set({ salt, predicted }))
      .catch((e) => !stop && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      stop = true;
    };
  }, [ready, over.length, state.predicted, state.salt, owner, nLanes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!DESK_FACTORY) return <Status tone="warning">Not deployed yet: set NEXT_PUBLIC_DESK_FACTORY once DeskLaneFactory is live on chain {CHAIN_ID}.</Status>;
  if (!factory) return <p className="text-sm text-ink-2">{factoryError ? `Factory read failed: ${factoryError}` : "Reading the factory…"}</p>;
  if (!factory.implementation) return <Status tone="warning">The factory has no DeskLaneV3 implementation registered yet.</Status>;
  if (!factory.poolAllowed) return <Status tone="warning">The factory has not allowed the NVDA/USDG pool yet.</Status>;
  if (over.length) return <Status tone="critical">Default caps exceed the factory ceilings: {over.join(", ")}.</Status>;
  if (err) return <Status tone="critical">predictLane failed: {err}</Status>;
  if (!state.predicted) return <p className="text-sm text-ink-2">Predicting your lane address…</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">Your lane will be deployed at exactly this address (the factory salt commits to every parameter, so nobody can deploy anything else there):</p>
      <div className="rounded-lg bg-surface-2 p-3">
        <Addr address={state.predicted} full />
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>In the Dynamic dashboard, open the delegated-access policy for this environment.</li>
        <li>Allow chain {CHAIN_ID} only, with this lane as the only allowed destination and a value of 0.</li>
        <li>Save. The Operator&apos;s signatures are now refused for anything but this lane.</li>
      </ol>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={state.policyAck} onChange={(e) => set({ policyAck: e.target.checked })} />
        I added the lane address to the Operator&apos;s policy allowlist.
      </label>
    </div>
  );
}

function CreateStep({ session, params, predicted, onCreated }: { session: DeskSession; params: CreateParams | null; predicted: Address | null; onCreated: (lane: Address) => void }) {
  const action = useAction();
  const create = () =>
    action.run("Confirm in your Vault…", async (onHash, done) => {
      if (!session.vault || !params || !predicted || !DESK_FACTORY) throw new Error("Missing Vault, parameters or factory.");
      if (await hasCode(predicted)) {
        onCreated(predicted);
        return done("Lane already exists at the predicted address");
      }
      const data = encodeFunctionData({ abi: deskLaneFactoryAbi, functionName: "createLane", args: [params] });
      const { receipt } = await sendFromWallet(session.vault, DESK_FACTORY, data, onHash);
      const ev = parseEventLogs({ abi: deskLaneFactoryAbi, eventName: "LaneCreated", logs: receipt.logs })[0];
      const lane = ev ? getAddress(ev.args.lane) : predicted;
      onCreated(lane);
      done(lane.toLowerCase() === predicted.toLowerCase() ? "Lane created" : `Lane created at ${short(lane)}, not the predicted address: re-check your Dynamic policy`);
    });
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Your Vault calls <code className="font-mono">createLane</code> on the factory with the caps on the right. The Vault becomes the immutable owner; the Operator gets only the agent role.
      </p>
      <Btn kind="primary" disabled={action.busy || !params} onClick={create}>
        Create lane from your Vault
      </Btn>
      <TxLine state={action.state} />
    </div>
  );
}

function DelegateStep({ session, lane, operator, kind }: { session: DeskSession; lane: Address | null; operator: Address | null; kind: WizardState["operatorKind"] }) {
  const action = useAction();
  const agent = usePoll(lane ? () => deskApi<DeskStatus>(`/${lane}/status`, { jwt: session.jwt() }) : null, 5000, `agent:${lane}`);
  if (kind === "server") return <p className="text-sm text-ink-2">Plan B: DeltaDesk&apos;s server wallet is the Operator, so there is nothing to delegate.</p>;
  const opStatus = session.delegationOf(operator);
  const vaultStatus = session.vault ? session.delegationOf(session.vault.address) : "unknown";
  const agentView = agent.data?.ok ? (agent.data.data.delegation?.status ?? "unknown") : agent.data?.status === 404 ? "confirmed at registration" : agent.data ? "unavailable" : "checking…";
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Delegate <strong>only the Operator</strong> to DeltaDesk, so the agent can sign for it within the lane&apos;s limits. Your Vault is never delegated.
      </p>
      {session.delegatedAccessEnabled === false && (
        <Notice tone="warning" title="Delegated access is off">
          Enable delegated access for embedded wallets in this Dynamic environment, then reload.
        </Notice>
      )}
      <ul className="space-y-1 text-sm">
        <li>
          <Status tone={opStatus === "delegated" ? "good" : "warning"}>Operator: {opStatus}</Status>
        </li>
        <li>
          <Status tone={vaultStatus === "delegated" ? "critical" : "good"}>Vault: {vaultStatus === "delegated" ? "delegated (revoke it!)" : "not delegated"}</Status>
        </li>
        <li className="text-ink-2">desk-agent key share: {agentView}</li>
      </ul>
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

function RegisterStep({ session, lane, onRegistered }: { session: DeskSession; lane: Address | null; onRegistered: () => void }) {
  const action = useAction();
  const [registered, setRegistered] = useState(false);
  if (!lane) return null;
  const register = () =>
    action.run("Registering with desk-agent…", async (_h, done) => {
      const r = await deskApi("/register", { method: "POST", body: { lane, chainId: CHAIN_ID }, jwt: session.jwt() });
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
