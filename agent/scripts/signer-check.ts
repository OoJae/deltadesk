// `pnpm signer-check [--lane 0x…] [--denial-chain <id> --denial-token 0x…]`: prove the operator signer works and that the Dynamic policy
// bites, WITHOUT sending anything. This script has no broadcaster: nothing it signs can leave it.
//
//   1. the RPC is the configured chain; the signer is the lane's operator and never its owner.
//   2. sign a lane `signal()` (neutral, event-only) with real nonce and fees, then verify the bytes
//      (parse == request, recover == operator). Printed by hash only; the bytes are discarded.
//   3. ask the signer for an operator `USDG.transfer(owner, 1)`: the Dynamic policy (chain 4663,
//      allowlist = the lane, value 0) must DENY it. The denial is classified (SIGNER_DENIED) and
//      recorded under data/signer-check/. A signature here means the policy is NOT enforced.
//
// Exit codes: 0 = signed + denial recorded, 2 = policy not enforced (or no denial), 1 = error.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeFunctionData, erc20Abi, keccak256, stringToBytes } from "viem";
import { ADDRESSES_4663 } from "../src/addresses.js";
import { assertSignerBinding, getConfig } from "../src/config.js";
import { createCalldataBuilder } from "../src/executor/calldata.js";
import { createChainClient, createLaneViews } from "../src/executor/chain.js";
import { encodeDecisionId, newDecisionUlid } from "../src/executor/decision-id.js";
import { classifySignerError } from "../src/executor/errors.js";
import { createFeePolicy, gasLimitFor } from "../src/executor/fees.js";
import { createSimulator } from "../src/executor/simulate.js";
import { signerFromConfig } from "../src/signer/factory.js";
import { signWithTimeout, verifySignedTx } from "../src/signer/types.js";
import { openDb } from "../src/state/db.js";
import type { Address, ChainClient, Hex, TxSigner, UnsignedTx } from "../src/types.js";

export interface SignerCheckDeps {
  chain: ChainClient;
  signer: TxSigner;
  lane: Address;
  chainId: number;
  feeFloorWei: bigint;
  feeCapWei: bigint;
  signTimeoutMs: number;
  nowMs: number;
  /** The token for the denial probe (USDG on 4663). */
  denialToken?: Address;
  /**
   * Chain id the denial probe is signed for (default: the lane's chain). Dynamic's policy engine
   * does not support Robinhood Chain (its policy API answers "Unsupported chainIds for EVM: 4663"),
   * so the probe can target a chain it does support (e.g. Base 8453) with the SAME delegated key.
   */
  denialChainId?: number;
}

export interface SignerCheckReport {
  lane: Address;
  signer: { kind: string; address: Address };
  owner: Address;
  operator: Address;
  laneTx: {
    hash: Hex;
    nonce: number;
    gas: string;
    maxFeePerGas: string;
    simulated: boolean;
    simError: string | null;
  };
  denial: {
    token: Address;
    chainId: number;
    outcome: "denied" | "signed" | "error";
    code: string | null;
    message: string;
  };
}

export async function runSignerCheck(d: SignerCheckDeps): Promise<SignerCheckReport> {
  const rpcChainId = await d.chain.chainId();
  if (rpcChainId !== d.chainId)
    throw new Error(`RPC reports chain ${rpcChainId}, expected ${d.chainId}`);
  const block = await d.chain.getBlock("latest");
  const id = await createLaneViews(d.chain).identity(d.lane, block.number);
  assertSignerBinding(d.signer.address, id);
  const ready = await d.signer.ready();
  if (!ready.ready) throw new Error(`signer not ready: ${ready.reason ?? "unknown"}`);

  // 2. A lane signal(), signed and verified, never sent.
  const ulid = newDecisionUlid(d.nowMs);
  const meta = {
    decisionId: encodeDecisionId(ulid, 0),
    deadline: BigInt(Math.floor(d.nowMs / 1000) + 45),
    regime: 0,
    gatesMask: 0,
    reasonHash: keccak256(stringToBytes("signer-check")),
  };
  const call = createCalldataBuilder(d.lane).encode(
    { kind: "signal", lane: "A", note: "signer-check" },
    meta,
  );
  const sim = await createSimulator({ chain: d.chain }).simulate(
    call,
    d.signer.address,
    block.number,
  );
  const fee = createFeePolicy({ floorWei: d.feeFloorWei, capWei: d.feeCapWei }).quote(block);
  const nonce = await d.chain.getTransactionCount(d.signer.address, "pending");
  const laneTx: UnsignedTx = {
    type: "eip1559",
    chainId: d.chainId,
    to: call.to,
    data: call.data,
    value: 0n,
    nonce,
    gas: gasLimitFor(sim.gasEstimate ?? 150_000n),
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: 0n,
  };
  const raw = await signWithTimeout(d.signer, laneTx, d.signTimeoutMs);
  const { hash } = await verifySignedTx(raw, laneTx, d.signer.address);

  // 3. The policy probe: an operator USDG.transfer that the Dynamic policy must refuse to sign.
  const token = (d.denialToken ?? ADDRESSES_4663.USDG).toLowerCase() as Address;
  const probeChainId = d.denialChainId ?? laneTx.chainId;
  const probe: UnsignedTx = {
    ...laneTx,
    chainId: probeChainId,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [id.owner, 1n] }),
    gas: 100_000n,
  };
  let denial: SignerCheckReport["denial"];
  try {
    await signWithTimeout(d.signer, probe, d.signTimeoutMs);
    denial = {
      token,
      chainId: probeChainId,
      outcome: "signed",
      code: null,
      message: `the signer SIGNED an operator token transfer on chain ${probeChainId}: policy not enforced`,
    };
  } catch (err) {
    const e = classifySignerError(err);
    denial =
      e.code === "SIGNER_DENIED"
        ? { token, chainId: probeChainId, outcome: "denied", code: e.code, message: e.message }
        : { token, chainId: probeChainId, outcome: "error", code: e.code, message: e.message };
  }
  return {
    lane: d.lane,
    signer: { kind: d.signer.kind, address: d.signer.address },
    owner: id.owner,
    operator: id.operator,
    laneTx: {
      hash,
      nonce,
      gas: laneTx.gas.toString(),
      maxFeePerGas: laneTx.maxFeePerGas.toString(),
      simulated: sim.ok,
      simError: sim.error?.message ?? null,
    },
    denial,
  };
}

async function main(argv: string[]): Promise<number> {
  const cfg = await getConfig();
  const flag = (name: string): string | undefined => {
    const j = argv.indexOf(name);
    return j >= 0 ? argv[j + 1] : undefined;
  };
  const i = argv.indexOf("--lane");
  const lane = ((i >= 0 ? argv[i + 1] : undefined) ?? cfg.lanes.A)?.toLowerCase() as
    | Address
    | undefined;
  if (lane === undefined) throw new Error("pass --lane 0x… or set DESK_LANE_A");
  const chain = createChainClient({
    rpcUrl: cfg.rpcUrl,
    fallbackUrl: cfg.rpcFallbackUrl,
    chainId: cfg.chainId,
  });
  const db = openDb(cfg.paths.dbPath);
  try {
    const block = await chain.blockNumber();
    const { operator } = await createLaneViews(chain).identity(lane, block);
    const signer = signerFromConfig(cfg, db, operator);
    const report = await runSignerCheck({
      chain,
      signer,
      lane,
      chainId: cfg.chainId,
      feeFloorWei: cfg.limits.feeFloorWei,
      feeCapWei: cfg.limits.maxFeePerGasWei,
      signTimeoutMs: cfg.timing.signTimeoutMs,
      nowMs: Date.now(),
      ...(flag("--denial-chain") === undefined
        ? {}
        : { denialChainId: Number(flag("--denial-chain")) }),
      ...(flag("--denial-token") === undefined
        ? {}
        : { denialToken: (flag("--denial-token") as string).toLowerCase() as Address }),
    });
    const dir = join("data", "signer-check");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replaceAll(":", "-")}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`,
    );
    console.log(
      `lane tx signed and verified (NOT broadcast): ${report.laneTx.hash} nonce ${report.laneTx.nonce}`,
    );
    console.log(
      `policy probe: ${report.denial.outcome.toUpperCase()} ${report.denial.code ?? ""} ${report.denial.message}`,
    );
    console.log(`evidence: ${file}`);
    return report.denial.outcome === "denied" ? 0 : 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
