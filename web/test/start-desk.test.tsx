// @vitest-environment happy-dom
// The real "Start a desk" wizard under a fake Dynamic session. Chain reads, the factory address and desk-agent (through
// deskApi) are stubbed; the agent's delegation record and Dynamic's client-side status are driven by each test.
import { act, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StartDesk from "@/components/desk/StartDesk";
import { DeskSessionContext } from "@/components/desk/context";
import type { DeskSession } from "@/components/desk/session";
import { DEFAULT_CAPS } from "@/lib/desk/caps";
import type { Preflight } from "@/lib/desk/create";
import type { AgentResult } from "@/lib/desk/types";
import { advance, mount, type Mounted } from "./dom";

const h = vi.hoisted(() => ({
  VAULT: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
  OP: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address,
  LANE: "0x1111111111111111111111111111111111111111" as Address,
  NEW_LANE: "0x2222222222222222222222222222222222222222" as Address,
  FACTORY: "0x9999999999999999999999999999999999999999" as Address,
  /** desk-agent's delegation row for the Operator; updatedAtMs is when it last changed (see agentRecords). */
  agent: { status: "active" as "active" | "revoked" | "unknown", updatedAtMs: 0, polls: 0 },
  register: { ok: true, data: {} } as unknown,
  preflight: null as unknown,
  setDelegated: (() => {}) as (delegated: boolean) => void,
  /** Runs when the wizard delegates the Operator in Dynamic (e.g. schedules the webhook reaching desk-agent). */
  onDelegate: () => {},
}));

vi.mock("@/lib/desk/config", async (orig) => ({ ...(await orig<typeof import("@/lib/desk/config")>()), DESK_FACTORY: h.FACTORY }));
vi.mock("@/lib/desk/api", () => ({
  deskApi: vi.fn(async (path: string) => {
    if (path.startsWith("/delegations/")) {
      h.agent.polls++;
      const row = h.agent.status !== "unknown";
      return { ok: true, data: { operator: h.OP, status: h.agent.status, walletId: row ? "w1" : null, updatedAtMs: row ? h.agent.updatedAtMs : null } };
    }
    if (path === "/register") return h.register;
    return { ok: false, status: 404, error: "not found" };
  }),
}));
vi.mock("@/lib/desk/reads", async (orig) => {
  const real = await orig<typeof import("@/lib/desk/reads")>();
  const { DEFAULT_CAPS: caps } = await import("@/lib/desk/caps");
  return {
    ...real,
    readFactory: vi.fn(async () => ({ implementation: "0x8888888888888888888888888888888888888888", pending: null, poolAllowed: true, ceilings: caps, lanes: [] })),
    readEthBalances: vi.fn(async (addrs: string[]) => addrs.map(() => BigInt(10) ** BigInt(18))),
    readLane: vi.fn(async () => null),
    readLaneRoles: vi.fn(async () => []),
    readPrices: vi.fn(async () => ({ nvdaUsd: 180, usdgUsd: 1, nvdaUpdatedAt: null })),
    readTokenBalances: vi.fn(async () => ({ bal0: BigInt(0), bal1: BigInt(0) })),
    predictLane: vi.fn(async () => h.NEW_LANE),
  };
});
vi.mock("@/lib/desk/create", async (orig) => ({ ...(await orig<typeof import("@/lib/desk/create")>()), preflight: vi.fn(async () => h.preflight) }));

const { VAULT, OP, LANE, NEW_LANE } = h;
const KEY = `deltadesk:wizard:${VAULT.toLowerCase()}`;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const REVOKED_NOTICE = "desk-agent has this Operator's delegation as revoked";
/** DelegateStep's poll interval (DELEGATION_POLL_MS). */
const DELEGATION_POLL = 3000;

/** Wizard progress up to "Delegate the Operator": Operator picked, gas acknowledged, lane predicted, allowlisted and created. */
const SETUP = {
  operator: OP,
  operatorKind: "embedded",
  gasAck: true,
  salt: `0x${"11".repeat(32)}`,
  predicted: LANE,
  policyAck: true,
  lane: LANE as Address | null,
  fundAck: false,
  registered: false,
  agentDelegation: null as Address | null,
  moved: null,
};
const seed = (patch: Partial<typeof SETUP> & Record<string, unknown>) => localStorage.setItem(KEY, JSON.stringify({ ...SETUP, ...patch }));
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as typeof SETUP & Record<string, unknown>;

/** StartDesk with a Dynamic session whose Operator delegation status the test flips (h.setDelegated). */
function Desk({ delegated: initial }: { delegated: boolean }) {
  const [delegated, setDelegated] = useState(initial);
  useEffect(() => {
    h.setDelegated = setDelegated;
  }, []);
  const session = useMemo(() => {
    const vault = { address: VAULT };
    const op = { address: OP };
    return {
      sdkHasLoaded: true,
      loggedIn: true,
      email: null,
      vault,
      others: [op],
      walletFor: (a?: string | null) => (same(a, VAULT) ? vault : same(a, OP) ? op : null),
      delegatedAccessEnabled: true,
      unsafeDelegationSettings: [],
      delegationOf: (a?: string | null) => (same(a, OP) ? (delegated ? "delegated" : "pending") : same(a, VAULT) ? "denied" : "unknown"),
      createOperator: async () => OP,
      createVault: async () => {},
      delegateOnly: async () => {
        setDelegated(true);
        h.onDelegate();
      },
      revokeDynamicDelegation: async () => {
        setDelegated(false);
        return true;
      },
      signIn: () => {},
      signOut: async () => {},
      jwt: () => "a.b.c",
    } as unknown as DeskSession;
  }, [delegated]);
  return (
    <DeskSessionContext.Provider value={session}>
      <StartDesk />
    </DeskSessionContext.Provider>
  );
}

/** desk-agent records `status` for the Operator now (a webhook landed, or a revoke or local purge). */
const agentRecords = (status: typeof h.agent.status) => {
  h.agent.status = status;
  h.agent.updatedAtMs = Date.now();
};

/** desk-agent receives Dynamic's webhook for the new delegation `ms` after the wizard delegates. */
const webhookAfter = (ms: number) => {
  h.onDelegate = () => {
    setTimeout(() => agentRecords("active"), ms);
  };
};

let ui: Mounted | null = null;
const open = async (delegated: boolean) => {
  ui = await mount(<Desk delegated={delegated} />);
  await advance(0);
  return ui;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  h.agent = { status: "active", updatedAtMs: Date.now(), polls: 0 };
  h.register = { ok: true, data: {} } satisfies AgentResult<unknown>;
  h.onDelegate = () => {};
});
afterEach(() => {
  ui?.unmount();
  ui = null;
  vi.useRealTimers();
});

describe("step 6: desk-agent's confirmation of the Operator's delegation", () => {
  it("a saved confirmation does not carry over to a new Dynamic delegation", async () => {
    seed({ agentDelegation: OP });
    const w = await open(true);
    expect(w.activeStep()).toBe("Fund the lane");

    // The Operator's delegation is revoked in Dynamic; desk-agent records the revoke.
    agentRecords("revoked");
    await advance(0);
    await act(async () => h.setDelegated(false));
    expect(w.activeStep()).toBe("Delegate the Operator");

    webhookAfter(4000);
    const before = h.agent.polls;
    await w.click("Delegate the Operator only");
    await advance(1500);
    // Delegated again in Dynamic, but desk-agent has not confirmed the new delegation yet.
    expect(w.activeStep()).toBe("Delegate the Operator");
    expect(h.agent.polls).toBeGreaterThan(before);

    await advance(12_000);
    expect(w.activeStep()).toBe("Fund the lane");
    expect(saved().agentDelegation).toBe(OP);
  });

  it("reopens when desk-agent no longer has the delegation although Dynamic still shows it", async () => {
    // desk-agent dropped the unbound delegation (its 24 h expiry) while the user was away funding the lane.
    seed({ agentDelegation: OP });
    agentRecords("revoked");
    const w = await open(true);
    await advance(DELEGATION_POLL);
    expect(w.activeStep()).toBe("Delegate the Operator");
    expect(w.text()).toContain(REVOKED_NOTICE);
    expect(saved().agentDelegation).toBeNull();
  });

  it("registering against a delegation desk-agent dropped reopens step 6", async () => {
    seed({ agentDelegation: OP, fundAck: true });
    const w = await open(true);
    expect(w.activeStep()).toBe("Register with the agent");

    agentRecords("revoked");
    h.register = { ok: false, status: 412, error: `operator ${OP.toLowerCase()} has no active delegation yet` } satisfies AgentResult<unknown>;
    await w.click("Register desk");
    await advance(DELEGATION_POLL);
    expect(w.activeStep()).toBe("Delegate the Operator");
    expect(w.text()).toContain(REVOKED_NOTICE);
    expect(saved().agentDelegation).toBeNull();
  });

  it("an unrelated registration error leaves step 6 done", async () => {
    seed({ agentDelegation: OP, fundAck: true });
    const w = await open(true);
    h.register = { ok: false, status: 403, error: "the operator was delegated by another user" } satisfies AgentResult<unknown>;
    await w.click("Register desk");
    await advance(0);
    expect(w.activeStep()).toBe("Register with the agent");
    expect(w.text()).toContain("the operator was delegated by another user");
    expect(saved().agentDelegation).toBe(OP);
  });

  it("the other 412 (the lane's operator is not this agent's wallet) leaves step 6 done", async () => {
    seed({ agentDelegation: OP, fundAck: true });
    const w = await open(true);
    h.register = { ok: false, status: 412, error: `the lane's operator ${OP.toLowerCase()} is not this agent's server wallet` } satisfies AgentResult<unknown>;
    await w.click("Register desk");
    await advance(DELEGATION_POLL);
    expect(w.activeStep()).toBe("Register with the agent");
    expect(w.text()).toContain("is not this agent's server wallet");
    expect(saved().agentDelegation).toBe(OP);
  });
});

describe("step 6: polling desk-agent after a (re-)delegation", () => {
  it("waits through desk-agent's revoked record of the previous delegation until the new one lands", async () => {
    agentRecords("revoked"); // the Operator's earlier delegation, revoked
    seed({});
    const w = await open(false);
    expect(w.activeStep()).toBe("Delegate the Operator");

    webhookAfter(4000);
    await w.click("Delegate the Operator only");
    await advance(1500);
    expect(w.activeStep()).toBe("Delegate the Operator");
    expect(w.text()).not.toContain(REVOKED_NOTICE);
    expect(w.text()).toContain("waiting for Dynamic's webhook");

    await advance(12_000);
    expect(w.activeStep()).toBe("Fund the lane");
    expect(h.agent.polls).toBeGreaterThan(1);
  });

  it("the revoked notice's own fix (revoke in Dynamic, delegate again) completes the step", async () => {
    // Dynamic shows the Operator delegated from before this visit; desk-agent has that delegation as revoked.
    agentRecords("revoked");
    seed({});
    const w = await open(true);
    await advance(0);
    expect(w.text()).toContain(REVOKED_NOTICE);
    const polls = h.agent.polls;
    await advance(30_000);
    expect(h.agent.polls).toBe(polls); // a revoke that predates this step is final: no more polling

    await w.click("Revoke in Dynamic");
    await advance(0);
    webhookAfter(4000);
    await w.click("Delegate the Operator only");
    await advance(1500);
    expect(w.text()).not.toContain(REVOKED_NOTICE);
    await advance(12_000);
    expect(w.activeStep()).toBe("Fund the lane");
  });

  it("a revoke desk-agent records after this delegation began is final at once", async () => {
    h.agent.status = "unknown"; // no row yet: the webhook has not landed
    seed({});
    const w = await open(false);
    await w.click("Delegate the Operator only");
    await advance(40_000);
    expect(w.text()).not.toContain(REVOKED_NOTICE);

    agentRecords("revoked"); // e.g. revoked from another device, which this tab's Dynamic state doesn't show yet
    await advance(DELEGATION_POLL);
    expect(w.activeStep()).toBe("Delegate the Operator");
    expect(w.text()).toContain(REVOKED_NOTICE);
    const polls = h.agent.polls;
    await advance(30_000);
    expect(h.agent.polls).toBe(polls);
  });

  it("shows the revoked notice once the wait runs out and desk-agent still has only the revoked record", async () => {
    agentRecords("revoked");
    seed({});
    const w = await open(false);
    await w.click("Delegate the Operator only"); // no webhook ever reaches desk-agent
    await advance(60_000);
    expect(w.text()).not.toContain(REVOKED_NOTICE);
    await advance(63_000);
    expect(w.activeStep()).toBe("Delegate the Operator");
    expect(w.text()).toContain(REVOKED_NOTICE);
  });
});

describe("step 4/5: predicting the lane again", () => {
  it('"Predict again" tells the user to replace the old address in the policy allowlist', async () => {
    seed({ lane: null });
    // The factory's implementation changed since step 4: createLane would now deploy at NEW_LANE.
    h.preflight = {
      lane: { lane: LANE, code: false, listed: false, inOwnerList: false, owner: null, operator: null, guardian: null, caps: null },
      fresh: NEW_LANE,
      pending: null,
    } satisfies Preflight;
    const w = await open(false);
    await advance(0);
    expect(w.activeStep()).toBe("Create the lane");

    await w.click("Predict again");
    await advance(0);
    expect(w.activeStep()).toBe("Predict the lane address");
    expect(saved().predicted).toBe(NEW_LANE);
    expect(w.text()).toContain("The predicted address changed");
    expect(w.text()).toContain(`instead of ${LANE}`);
    expect(w.text()).toContain("in place of the old one");

    // Confirming the updated policy clears the notice and moves on.
    h.preflight = { lane: { lane: NEW_LANE, code: false, listed: false, inOwnerList: false, owner: null, operator: null, guardian: null, caps: DEFAULT_CAPS }, fresh: NEW_LANE, pending: null } satisfies Preflight;
    await w.clickEl(w.el.querySelector("input[type=checkbox]"));
    await advance(0);
    expect(w.text()).not.toContain("The predicted address changed");
    expect(w.activeStep()).toBe("Create the lane");
    expect(saved().policyAck).toBe(true);
  });
});
