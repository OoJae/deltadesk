// @vitest-environment happy-dom
// exitAll never reverts on one bad slot: a position it can't unwind (a paused token) stays in its slot and the lane
// emits CollectFailed. The lane page's last-resort copy and the owner controls' exit note must say so.
import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LaneDesk, { LaneBody } from "@/components/desk/LaneDesk";
import OwnerControls from "@/components/desk/OwnerControls";
import { deskLaneAbi } from "@/lib/desk/abi/DeskLane";
import { DEFAULT_CAPS } from "@/lib/desk/caps";
import { LANE_A } from "@/lib/desk/chain";
import type { LaneState } from "@/lib/desk/reads";
import type { EthereumWallet } from "@/lib/desk/tx";
import { advance, mount, type Mounted } from "./dom";

const h = vi.hoisted(() => ({ logs: [] as unknown[], readLane: vi.fn() }));

vi.mock("@/lib/desk/reads", async (orig) => ({
  ...(await orig<typeof import("@/lib/desk/reads")>()),
  readLane: h.readLane,
  readEthBalances: vi.fn(async (a: readonly unknown[]) => a.map(() => BigInt(0))),
}));
vi.mock("@/lib/desk/api", () => ({ deskApi: vi.fn(async () => ({ ok: false, status: 404, error: "not found" })) }));
vi.mock("@/lib/desk/meta", async (orig) => ({
  ...(await orig<typeof import("@/lib/desk/meta")>()),
  ownerMeta: vi.fn(async () => ({ decisionId: `0x${"01".repeat(32)}`, deadline: BigInt(1_800_000_100), regime: 0, gatesMask: 0, reasonHash: `0x${"00".repeat(32)}` })),
}));
vi.mock("@/lib/desk/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/desk/tx")>()),
  sendFromWallet: vi.fn(async () => ({ hash: `0x${"ab".repeat(32)}`, receipt: { status: "success", logs: h.logs } })),
}));

const LANE: Address = "0x1111111111111111111111111111111111111111";
const VAULT: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OP: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const KEPT = BigInt(7);

const LANE_STATE: LaneState = {
  lane: LANE,
  owner: VAULT,
  operator: OP,
  guardian: zeroAddress,
  laneId: 0,
  pool: LANE_A.pool,
  paused: false,
  closedUntil: 0,
  caps: DEFAULT_CAPS,
  slots: [BigInt(3), KEPT],
  positions: [],
  budgets: { turnoverUsd6: BigInt(150_000_000), rr1h: 4, rr24h: 24, nextRerangeAt: 0 },
  riskAdding: { open: true, code: 0 },
  ref: null,
  pendingOperator: null,
  bal0: BigInt(0),
  bal1: BigInt(0),
  poolTick: null,
  prices: { nvdaUsd: 180, usdgUsd: 1, nvdaUpdatedAt: null },
  chainTime: 1_800_000_000,
};

const collectFailed = (tokenId: bigint, address: Address = LANE): TransactionReceipt["logs"][number] => ({
  address,
  topics: encodeEventTopics({ abi: deskLaneAbi, eventName: "CollectFailed", args: { tokenId } }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "bytes" }], ["0x"]),
  blockHash: `0x${"cd".repeat(32)}` as Hash,
  blockNumber: BigInt(1),
  logIndex: 0,
  transactionHash: `0x${"ab".repeat(32)}` as Hash,
  transactionIndex: 0,
  removed: false,
});

let ui: Mounted | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  h.logs = [];
});
afterEach(() => {
  ui?.unmount();
  ui = null;
  vi.useRealTimers();
});

describe("lane page before the first chain read", () => {
  // The loading state is the certificate frame, not a one-line shell: a short shell let the footer into the first
  // viewport and it jumped when the read landed (CLS 0.32). A failed read keeps the frame and retries.
  it("holds the certificate with the lane address, keeps it through a failed read, then fills it in", async () => {
    let fail: (e: Error) => void = () => {};
    h.readLane.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    h.readLane.mockResolvedValue(LANE_STATE);
    ui = await mount(<LaneDesk lane={LANE} />);
    const frame = () => ui!.el.querySelector("section[aria-label=Lane]");
    const status = () => ui!.el.querySelector("[role=status]")?.textContent;

    expect(frame()?.getAttribute("aria-busy")).toBe("true");
    expect(frame()?.textContent).toContain(LANE);
    expect(status()).toContain("Reading the lane from Robinhood Chain…");

    fail(new Error("HTTP request failed"));
    await advance(0);
    expect(frame()?.getAttribute("aria-busy")).toBe("false");
    expect(status()).toContain("Chain read failed");
    expect(ui.text()).toContain("Trying again every 5 s. Last error: HTTP request failed");

    await advance(5000);
    expect(frame()).toBeNull();
    expect(ui.el.querySelector("section[aria-label='Lane A']")?.textContent).toContain("Lane value");
  });
});

describe("If DeltaDesk is down", () => {
  it("says a slot can still hold a position after exitAll, not that exitAll fails", async () => {
    ui = await mount(<LaneBody s={LANE_STATE} operatorEth={null} session={null} error={null} refresh={() => {}} />);
    const text = ui.text();
    expect(text).toContain("If a slot still holds a position after exitAll");
    expect(text).toContain("it still succeeds, but the lane emits CollectFailed for that position and leaves it in its slot");
    expect(text).toContain("slot 1: NFT #7");
    expect(text).not.toContain("If exitAll fails");
  });
});

describe("owner controls: Exit all", () => {
  const exitAll = async () => {
    const vault = { address: VAULT } as EthereumWallet;
    ui = await mount(<OwnerControls s={LANE_STATE} signer={{ vault, blocked: null }} onDone={() => {}} />);
    await ui.click("Exit all");
    await ui.click("Confirm exit all");
    await advance(0);
    return ui.text();
  };

  it("names the position exitAll left in its slot", async () => {
    // The full collect and the per-side retry each emit CollectFailed for the same position; another contract's is ignored.
    h.logs = [collectFailed(KEPT), collectFailed(KEPT), collectFailed(BigInt(99), OP)];
    const text = await exitAll();
    expect(text).toContain("Exited, but NFT #7 (slot 1) could not be unwound");
    expect(text).toContain("stays in its slot");
    expect(text).not.toContain("NFT #99");
    expect(text).not.toContain("All positions unwound");
  });

  it("says all positions were unwound when none stayed", async () => {
    expect(await exitAll()).toContain("All positions unwound");
  });
});
