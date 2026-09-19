// Read-only chain views for the desk UI. Every read goes straight to Robinhood Chain; nothing depends on desk-agent.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { deskLaneAbi } from "./abi/DeskLane";
import { deskLaneFactoryAbi } from "./abi/DeskLaneFactory";
import { aggregatorAbi, erc20Abi, npmAbi, v3PoolAbi } from "./abi/external";
import type { Caps } from "./caps";
import { ADDR, KIND_V3_LP, LANE_A, publicClient } from "./chain";

export type CreateParams = {
  owner: Address;
  operator: Address;
  guardian: Address;
  laneId: number;
  kind: number;
  pool: Address;
  caps: Caps;
  salt: Hex;
};

export type NpmPosition = { slot: 0 | 1; tokenId: bigint; tickLower: number; tickUpper: number; liquidity: bigint; owed0: bigint; owed1: bigint };

export type LaneState = {
  lane: Address;
  owner: Address;
  operator: Address;
  guardian: Address;
  laneId: number;
  pool: Address;
  paused: boolean;
  closedUntil: number;
  caps: Caps | null;
  slots: [bigint, bigint];
  positions: NpmPosition[];
  budgets: { turnoverUsd6: bigint; rr1h: number; rr24h: number; nextRerangeAt: number } | null;
  riskAdding: { open: boolean; code: number } | null;
  ref: { tick: number; band: number; code: number } | null;
  pendingOperator: { operator: Address; eta: number } | null;
  bal0: bigint;
  bal1: bigint;
  poolTick: number | null;
  prices: Prices;
  chainTime: number;
};

export type Prices = { nvdaUsd: number | null; usdgUsd: number | null; nvdaUpdatedAt: number | null };

const ok = <T,>(r: { status: "success"; result: T } | { status: "failure"; error: Error }): T | null => (r.status === "success" ? r.result : null);

/** Chainlink NVDA/USD and USDG/USD, decimals read live (the feeds moved from 18 to 8 decimals on Jun 23). */
export async function readPrices(): Promise<Prices> {
  const r = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: ADDR.CL_NVDA_USD, abi: aggregatorAbi, functionName: "latestRoundData" },
      { address: ADDR.CL_NVDA_USD, abi: aggregatorAbi, functionName: "decimals" },
      { address: ADDR.CL_USDG_USD, abi: aggregatorAbi, functionName: "latestRoundData" },
      { address: ADDR.CL_USDG_USD, abi: aggregatorAbi, functionName: "decimals" },
    ],
  });
  const px = (round: readonly [bigint, bigint, bigint, bigint, bigint] | null, dec: number | null) =>
    round && dec != null && round[1] > BigInt(0) ? Number(round[1]) / 10 ** dec : null;
  const nvda = ok(r[0]);
  return { nvdaUsd: px(nvda, ok(r[1])), usdgUsd: px(ok(r[2]), ok(r[3])), nvdaUpdatedAt: nvda ? Number(nvda[3]) : null };
}

export async function readEthBalances(addrs: Address[]): Promise<bigint[]> {
  return Promise.all(addrs.map((a) => publicClient.getBalance({ address: a })));
}

export async function readTokenBalances(holder: Address): Promise<{ bal0: bigint; bal1: bigint }> {
  const r = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: LANE_A.token0, abi: erc20Abi, functionName: "balanceOf", args: [holder] },
      { address: LANE_A.token1, abi: erc20Abi, functionName: "balanceOf", args: [holder] },
    ],
  });
  return { bal0: r[0], bal1: r[1] };
}

export async function hasCode(addr: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address: addr });
  return !!code && code !== "0x";
}

/** Returns null when `lane` has no code or does not answer as a DeskLane. */
export async function readLane(lane: Address): Promise<LaneState | null> {
  const c = { address: lane, abi: deskLaneAbi } as const;
  const [r, block] = await Promise.all([
    publicClient.multicall({
      allowFailure: true,
      contracts: [
        { ...c, functionName: "owner" },
        { ...c, functionName: "operator" },
        { ...c, functionName: "guardian" },
        { ...c, functionName: "laneId" },
        { ...c, functionName: "pool" },
        { ...c, functionName: "paused" },
        { ...c, functionName: "closedUntil" },
        { ...c, functionName: "caps" },
        { ...c, functionName: "positions" },
        { ...c, functionName: "budgets" },
        { ...c, functionName: "riskAddingOpen" },
        { ...c, functionName: "refTick" },
        { ...c, functionName: "pendingOperator" },
        { address: LANE_A.token0, abi: erc20Abi, functionName: "balanceOf", args: [lane] },
        { address: LANE_A.token1, abi: erc20Abi, functionName: "balanceOf", args: [lane] },
        { address: LANE_A.pool, abi: v3PoolAbi, functionName: "slot0" },
      ],
    }),
    publicClient.getBlock({ blockTag: "latest" }),
  ]);
  const owner = ok(r[0]);
  if (!owner) return null;
  const slots = ok(r[8]) ?? [BigInt(0), BigInt(0)];
  const budgets = ok(r[9]);
  const risk = ok(r[10]);
  const ref = ok(r[11]);
  const pend = ok(r[12]);
  const slot0 = ok(r[15]);

  const live = ([0, 1] as const).filter((s) => slots[s] > BigInt(0));
  const [npm, prices] = await Promise.all([
    live.length
      ? publicClient.multicall({ allowFailure: true, contracts: live.map((s) => ({ address: ADDR.NPM, abi: npmAbi, functionName: "positions", args: [slots[s]] }) as const) })
      : Promise.resolve([]),
    readPrices(),
  ]);
  const positions: NpmPosition[] = [];
  live.forEach((slot, i) => {
    const p = npm[i] ? ok(npm[i]) : null;
    if (p) positions.push({ slot, tokenId: slots[slot], tickLower: p[5], tickUpper: p[6], liquidity: p[7], owed0: p[10], owed1: p[11] });
  });

  return {
    lane,
    owner,
    operator: ok(r[1]) ?? ("0x0000000000000000000000000000000000000000" as Address),
    guardian: ok(r[2]) ?? ("0x0000000000000000000000000000000000000000" as Address),
    laneId: ok(r[3]) ?? 0,
    pool: ok(r[4]) ?? LANE_A.pool,
    paused: ok(r[5]) ?? false,
    closedUntil: Number(ok(r[6]) ?? 0),
    caps: ok(r[7]),
    slots: [slots[0], slots[1]],
    positions,
    budgets: budgets ? { turnoverUsd6: budgets[0], rr1h: Number(budgets[1]), rr24h: Number(budgets[2]), nextRerangeAt: Number(budgets[3]) } : null,
    riskAdding: risk ? { open: risk[0], code: risk[1] } : null,
    ref: ref ? { tick: ref[0], band: ref[1], code: ref[2] } : null,
    pendingOperator: pend && pend[1] > BigInt(0) ? { operator: pend[0], eta: Number(pend[1]) } : null,
    bal0: ok(r[13]) ?? BigInt(0),
    bal1: ok(r[14]) ?? BigInt(0),
    poolTick: slot0 ? slot0[1] : null,
    prices,
    chainTime: Number(block.timestamp),
  };
}

export type FactoryState = { implementation: Address | null; poolAllowed: boolean; ceilings: Caps | null; lanes: readonly Address[] };

export async function readFactory(factory: Address, owner: Address | null): Promise<FactoryState> {
  const f = { address: factory, abi: deskLaneFactoryAbi } as const;
  const r = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { ...f, functionName: "implementations", args: [KIND_V3_LP] },
      { ...f, functionName: "poolAllowed", args: [LANE_A.pool, KIND_V3_LP] },
      { ...f, functionName: "ceilings" },
      { ...f, functionName: "lanesOf", args: [owner ?? "0x0000000000000000000000000000000000000000"] },
    ],
  });
  const impl = ok(r[0]);
  return {
    implementation: impl && BigInt(impl) !== BigInt(0) ? impl : null,
    poolAllowed: ok(r[1]) ?? false,
    ceilings: ok(r[2]),
    lanes: owner ? (ok(r[3]) ?? []) : [],
  };
}

/**
 * Salt for the owner's n-th lane. It only has to separate lanes whose other params are identical (the factory salt is
 * keccak256(abi.encode(params)) anyway), and it is deterministic so a reload re-derives the same prediction.
 */
export const laneSalt = (owner: Address, n: number): Hex =>
  keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "uint256" }], ["DeltaDesk lane", owner, BigInt(n)]));

export async function predictLane(factory: Address, p: CreateParams): Promise<Address> {
  return publicClient.readContract({ address: factory, abi: deskLaneFactoryAbi, functionName: "predictLane", args: [p] });
}

/** Caps fields that exceed the factory ceilings, in the direction documented in IDeskTypes (min* fields are floors). */
export function capsAboveCeilings(caps: Caps, ceil: Caps): string[] {
  const out: string[] = [];
  const max = <K extends keyof Caps>(k: K) => {
    if (caps[k] > ceil[k]) out.push(k);
  };
  const min = <K extends keyof Caps>(k: K) => {
    if (caps[k] < ceil[k]) out.push(k);
  };
  max("maxDeployUsd6");
  max("turnoverUsd6PerDay");
  max("placeBandBps");
  max("maxTickDelta");
  min("minWidthTicks");
  max("maxWidthTicks");
  max("reranges1h");
  max("reranges24h");
  min("minRerangeInterval");
  max("maxDeadlineAhead");
  max("maxRanges");
  return out;
}
