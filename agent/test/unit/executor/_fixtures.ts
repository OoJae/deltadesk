/**
 * Test doubles for the execution path: a scriptable in-memory chain (no network), decision rows,
 * and signers built from well-known anvil keys against a loopback URL.
 */

import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { encodeDecisionId } from "../../../src/executor/decision-id.js";
import { createLocalSigner } from "../../../src/signer/local.js";
import type {
  Address,
  BlockHeader,
  ChainClient,
  ChainTx,
  DecisionRow,
  DeskDb,
  DeskRow,
  Hex,
  RawLog,
  TxReceipt,
  TxSigner,
} from "../../../src/types.js";
import { ANVIL_KEY_0, LANE, OWNER } from "../../helpers/fakes.js";

export { ANVIL_KEY_0, LANE, OWNER };
/** anvil account #1 and #2 (loopback only). */
export const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const ANVIL_KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const OPERATOR_ADDR = privateKeyToAccount(ANVIL_KEY_0).address.toLowerCase() as Address;
export const OTHER_ADDR = privateKeyToAccount(ANVIL_KEY_1).address.toLowerCase() as Address;
export const LOOPBACK = "http://127.0.0.1:8545";
export const T0 = Date.UTC(2026, 8, 21, 14, 0, 0);

export function localSigner(key: Hex = ANVIL_KEY_0): TxSigner {
  return createLocalSigner({ privateKey: key, rpcUrl: LOOPBACK });
}

let ulidSeq = 0;
/** Deterministic, valid, increasing ULIDs for tests. */
export function testUlid(): string {
  ulidSeq += 1;
  return `01K5HZ3N8QW${ulidSeq.toString().padStart(15, "0")}`;
}

export function decisionRow(decisionId: string, partial: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId,
    laneAddress: LANE,
    lane: "A",
    createdAtMs: T0,
    updatedAtMs: T0,
    regime: "REGULAR",
    regimeCode: 1,
    gatesMask: 0,
    riskMode: "normal",
    snapshotJson: "{}",
    planJson: "{}",
    overlayId: null,
    finalPlanJson: null,
    reasonHash: null,
    reasonPreimage: null,
    planCriticVerdict: null,
    planCriticReason: null,
    guardDecision: null,
    guardViolationsJson: null,
    guardChecksJson: null,
    approvalMode: null,
    approvalOutcome: null,
    approvalChannel: null,
    status: "executing",
    statusDetail: null,
    ...partial,
  };
}

export function deskRow(partial: Partial<DeskRow> = {}): DeskRow {
  return {
    laneAddress: LANE,
    chainId: 4663,
    laneId: 0,
    owner: OWNER,
    operator: OPERATOR_ADDR,
    ownerUserId: "user-1",
    signerKind: "local",
    mode: "copilot",
    modeNonce: 0,
    status: "active",
    statusDetail: null,
    capsJson: "{}",
    createdAtMs: T0,
    updatedAtMs: T0,
    ...partial,
  };
}

export function seedDecision(db: DeskDb, partial: Partial<DecisionRow> = {}): string {
  const id = testUlid();
  db.insertDecision(decisionRow(id, partial));
  return id;
}

export function metaFor(ulid: string, step: number, deadlineSec: number) {
  return {
    decisionId: encodeDecisionId(ulid, step),
    deadline: BigInt(deadlineSec),
    regime: 1,
    gatesMask: 0,
    reasonHash: keccak256("0x01"),
  };
}

type CallReq = Parameters<ChainClient["call"]>[0];

/** A scriptable chain. Defaults: every call returns "0x", sends are accepted and mined at once. */
export class FakeChain implements ChainClient {
  chainIdValue = 4663;
  head = 1_000n;
  timestampSec = BigInt(Math.floor(T0 / 1000));
  baseFee: bigint | null = 10_000_000n;
  callImpl: (req: CallReq) => Promise<Hex> = async () => "0x";
  estimateImpl: (req: { from: Address; to: Address; data: Hex }) => Promise<bigint> = async () =>
    400_000n;
  /** Throw from sendRawTransaction, once per queued error. */
  sendErrors: unknown[] = [];
  /** When true, an accepted tx gets a receipt immediately. */
  autoMine = true;
  /** Receipt status for auto-mined txs. */
  mineStatus: "success" | "reverted" = "success";
  /** When false (and autoMine is off), the node accepts a tx and then forgets it (dropped). */
  mempoolKeeps = true;
  counts = new Map<string, { pending: number; latest: number }>();
  balances = new Map<string, bigint>();
  sent: Hex[] = [];
  calls: CallReq[] = [];
  mempool = new Map<string, ChainTx>();
  receipts = new Map<string, TxReceipt>();
  logs: RawLog[] = [];
  getLogsCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];

  count(address: Address) {
    const k = address.toLowerCase();
    let c = this.counts.get(k);
    if (c === undefined) {
      c = { pending: 0, latest: 0 };
      this.counts.set(k, c);
    }
    return c;
  }

  async chainId() {
    return this.chainIdValue;
  }
  async blockNumber() {
    return this.head;
  }
  async getBlock(tag: "latest" | bigint): Promise<BlockHeader> {
    const n = tag === "latest" ? this.head : tag;
    return {
      number: n,
      timestamp: this.timestampSec,
      hash: keccak256(`0x${n.toString(16).padStart(8, "0")}`),
      baseFeePerGas: this.baseFee,
    };
  }
  async call(req: CallReq) {
    this.calls.push(req);
    return this.callImpl(req);
  }
  async estimateGas(req: { from: Address; to: Address; data: Hex }) {
    return this.estimateImpl(req);
  }
  async getTransactionCount(address: Address, tag: "pending" | "latest") {
    return this.count(address)[tag];
  }
  async getBalance(address: Address) {
    return this.balances.get(address.toLowerCase()) ?? 10n ** 18n;
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    const err = this.sendErrors.shift();
    if (err !== undefined) throw err;
    const hash = keccak256(raw);
    const tx = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerializedEIP1559,
      })
    ).toLowerCase() as Address;
    const c = this.count(from);
    c.pending = Math.max(c.pending, (tx.nonce ?? 0) + 1);
    if (this.autoMine) this.mine(hash, from, tx.nonce ?? 0, this.mineStatus);
    else if (this.mempoolKeeps)
      this.mempool.set(hash, { hash, from, nonce: tx.nonce ?? 0, blockNumber: null });
    return hash;
  }
  mine(hash: Hex, from: Address, nonce: number, status: "success" | "reverted" = "success") {
    this.head += 1n;
    this.mempool.delete(hash);
    const c = this.count(from);
    c.latest = Math.max(c.latest, nonce + 1);
    c.pending = Math.max(c.pending, c.latest);
    this.receipts.set(hash, {
      transactionHash: hash,
      status,
      blockNumber: this.head,
      gasUsed: 300_000n,
      effectiveGasPrice: this.baseFee ?? 10_000_000n,
      logs: [],
    });
  }
  async getTransaction(hash: Hex) {
    const r = this.receipts.get(hash);
    if (r !== undefined) return { hash, from: OPERATOR_ADDR, nonce: 0, blockNumber: r.blockNumber };
    return this.mempool.get(hash) ?? null;
  }
  async getTransactionReceipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  async getLogs(p: {
    address: Address;
    fromBlock: bigint;
    toBlock: bigint;
    topics?: (Hex | null)[];
  }) {
    this.getLogsCalls.push({ fromBlock: p.fromBlock, toBlock: p.toBlock });
    return this.logs.filter(
      (l) =>
        l.address.toLowerCase() === p.address.toLowerCase() &&
        l.blockNumber >= p.fromBlock &&
        l.blockNumber <= p.toBlock &&
        (p.topics?.[0] == null || l.topics[0]?.toLowerCase() === p.topics[0].toLowerCase()),
    );
  }
}

/** A LaneAction log as the lane would emit it. */
export function laneActionLog(p: {
  lane?: Address;
  decisionId: Hex;
  action: number;
  caller: Address;
  txHash: Hex;
  blockNumber: bigint;
  logIndex?: number;
  ticks?: number[];
}): RawLog {
  const topics = encodeEventTopics({
    abi: deskLaneAbi,
    eventName: "LaneAction",
    args: { lane: 0, decisionId: p.decisionId, action: p.action },
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "int24[]" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "uint16" },
      { type: "bytes32" },
      { type: "address" },
    ],
    [p.ticks ?? [], 0n, 1, 0, keccak256("0x02"), p.caller],
  );
  return {
    address: (p.lane ?? LANE).toLowerCase() as Address,
    topics,
    data,
    blockNumber: p.blockNumber,
    transactionHash: p.txHash,
    logIndex: p.logIndex ?? 0,
  };
}
