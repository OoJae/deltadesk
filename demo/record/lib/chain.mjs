// Read-only JSON-RPC helpers for the Robinhood Chain scenes (07, 08): who owns and operates the lane, who sent a tx,
// and the LaneAction log decoded with the lane's own ABI, so the video can show what Blockscout cannot decode yet
// (the lane implementation's source is on Sourcify, not on Blockscout). Nothing here signs or sends anything.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO } from "../../build/beats.mjs";

const REPO = join(DEMO, "..");

export async function rpc(cfg, method, params) {
  const r = await fetch(cfg.rhRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const addrOf = (w) => `0x${w.slice(-40)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// owner() 0x8da5cb5b, operator() 0x570ca735 (IDeskLane)
export async function laneRoles(cfg, lane) {
  const call = (data) => rpc(cfg, "eth_call", [{ to: lane, data }, "latest"]);
  const [owner, operator] = await Promise.all([call("0x8da5cb5b"), call("0x570ca735")]);
  return { owner: addrOf(owner), operator: addrOf(operator) };
}

export async function txFrom(cfg, hash) {
  const tx = await rpc(cfg, "eth_getTransactionByHash", [hash]);
  return tx ? { from: tx.from, to: tx.to, block: parseInt(tx.blockNumber, 16) } : null;
}

// Names from the repo's own sources: IDeskTypes.Action (contracts), REGIME_CODE and GATE_BITS (agent/src/types.ts).
function names() {
  const types = readFileSync(join(REPO, "contracts/src/interfaces/IDeskTypes.sol"), "utf8");
  const body = types.match(/enum Action\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const actions = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim().replace(/,$/, "")).filter(Boolean);
  const ts = readFileSync(join(REPO, "agent/src/types.ts"), "utf8");
  const regimes = {};
  for (const m of (ts.match(/REGIME_CODE[^{]*\{([\s\S]*?)\}/)?.[1] ?? "").matchAll(/(\w+):\s*(\d+)/g)) regimes[Number(m[2])] = m[1];
  const gates = [];
  for (const m of (ts.match(/GATE_BITS[^{]*\{([\s\S]*?)\}/)?.[1] ?? "").matchAll(/"?([A-Z-]+)"?:\s*1 << (\d+)/g)) gates.push([m[1], 1 << Number(m[2])]);
  if (!actions.length || !Object.keys(regimes).length || !gates.length) throw new Error("could not read Action / REGIME_CODE / GATE_BITS from the repo");
  return { actions, regimes, gates };
}

// LaneAction(uint8 indexed lane, bytes32 indexed decisionId, Action indexed action, int24[] ticks, uint256 refPxE18,
//            uint8 regime, uint16 gatesMask, bytes32 reasonHash, address caller)   (contracts/src/interfaces/IDeskLane.sol)
export const LANE_ACTION_TOPIC = "0x35dfe7eaaf14a5d70820932035e93a83bff4c40ef1f7eb8f6f1690f0c0349aa2";

export async function laneActionOf(cfg, hash) {
  const rc = await rpc(cfg, "eth_getTransactionReceipt", [hash]);
  if (!rc) throw new Error(`no receipt for ${hash}`);
  const log = rc.logs.find((l) => same(l.topics[0], LANE_ACTION_TOPIC));
  if (!log) throw new Error(`tx ${hash} has no LaneAction log`);
  const { actions, regimes, gates } = names();
  const d = log.data;
  const action = parseInt(log.topics[3], 16);
  const regime = parseInt(word(d, 2), 16);
  const mask = parseInt(word(d, 3), 16);
  const nTicks = parseInt(word(d, parseInt(word(d, 0), 16) / 32), 16);
  return {
    status: parseInt(rc.status, 16),
    block: parseInt(rc.blockNumber, 16),
    gasUsed: parseInt(rc.gasUsed, 16),
    from: rc.from,
    to: rc.to,
    lane: log.address,
    topics: log.topics,
    decisionId: log.topics[2],
    action,
    actionName: actions[action] ?? "?",
    ticks: nTicks,
    refPxE18: BigInt(`0x${word(d, 1)}`).toString(),
    regime,
    regimeName: regimes[regime] ?? "?",
    gatesMask: mask,
    gateNames: gates.filter(([, bit]) => mask & bit).map(([n]) => n),
    reasonHash: `0x${word(d, 4)}`,
    caller: addrOf(word(d, 5)),
  };
}

// The reasonHash preimage the agent stored, as recorded in docs/m2-desk.md §3b, and keccak256 of it (Foundry `cast`).
export function preimageCheck(reasonHash) {
  const doc = readFileSync(join(REPO, "docs/m2-desk.md"), "utf8");
  const pre = doc.match(/\|\s*Preimage[^|]*\|\s*`([^`]+)`\s*\|/)?.[1];
  if (!pre) return null;
  let hash = null;
  try {
    hash = execFileSync("cast", ["keccak", pre], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return { preimage: pre, hash: null, match: null };
  }
  return { preimage: pre, hash, match: same(hash, reasonHash) };
}
