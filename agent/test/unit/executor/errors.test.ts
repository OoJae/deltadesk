import {
  CallExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  encodeErrorResult,
  HttpRequestError,
  InternalRpcError,
  RpcRequestError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { describe, expect, it } from "vitest";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import {
  classifyError,
  classifySignerError,
  classifySimulationError,
  decodeRevert,
  LANE_ERROR_NAMES,
  revertDataOf,
} from "../../../src/executor/errors.js";
import { EXEC_ERROR_OUTCOME, ExecError } from "../../../src/types.js";

const ID = `0x${"11".repeat(32)}` as const;
const decisionUsed = encodeErrorResult({ abi: deskLaneAbi, errorName: "DecisionUsed", args: [ID] });
const outsideFence = encodeErrorResult({
  abi: deskLaneAbi,
  errorName: "RangeOutsideFence",
  args: [0, -222400, -222200, -222300, 100],
});

/** What viem throws for a reverting eth_call: CallExecutionError → ExecutionReverted → RpcRequestError(data). */
function viemCallRevert(data: `0x${string}`) {
  const rpc = new RpcRequestError({
    body: {},
    error: { code: 3, message: "execution reverted", data },
    url: "http://127.0.0.1:8545",
  });
  const reverted = new ExecutionRevertedError({ cause: rpc, message: "execution reverted" });
  return new CallExecutionError(reverted, {
    to: "0x1111111111111111111111111111111111111111",
  } as ConstructorParameters<typeof CallExecutionError>[1]);
}

describe("revert decoding", () => {
  it("knows the lane's custom errors", () => {
    expect(LANE_ERROR_NAMES.has("DecisionUsed")).toBe(true);
    expect(LANE_ERROR_NAMES.has("RangeOutsideFence")).toBe(true);
  });

  it("finds revert data deep in a viem cause chain and decodes it", () => {
    const err = viemCallRevert(outsideFence);
    expect(revertDataOf(err)).toBe(outsideFence);
    expect(decodeRevert(outsideFence)).toEqual({
      errorName: "RangeOutsideFence",
      args: [0, -222400, -222200, -222300, 100],
    });
  });

  it("reads ContractFunctionRevertedError.raw", () => {
    const err = new ContractFunctionRevertedError({
      abi: deskLaneAbi,
      data: decisionUsed,
      functionName: "rerange",
    });
    expect(revertDataOf(err)).toBe(decisionUsed);
    expect(classifyError(err).code).toBe("SIM_DECISION_USED");
  });
});

describe("classifyError (err.walk)", () => {
  it("DecisionUsed → SIM_DECISION_USED (reconcile)", () => {
    const e = classifyError(viemCallRevert(decisionUsed));
    expect(e.code).toBe("SIM_DECISION_USED");
    expect(e.outcome).toBe("reconcile");
  });

  it("any other lane custom error → SIM_POLICY (failed, no retry) with the decoded name", () => {
    const e = classifyError(viemCallRevert(outsideFence));
    expect(e.code).toBe("SIM_POLICY");
    expect(e.outcome).toBe("fail");
    expect((e.detail as { errorName: string }).errorName).toBe("RangeOutsideFence");
  });

  it("an undecodable revert is still SIM_POLICY", () => {
    expect(classifyError(viemCallRevert("0xdeadbeef00")).code).toBe("SIM_POLICY");
  });

  it.each([
    ["nonce too low", "NONCE_TOO_LOW"],
    ["already known", "NONCE_TOO_LOW"],
    ["nonce too high", "NONCE_CONFLICT"],
    ["max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 2", "FEE_CAP_TOO_LOW"],
    ["transaction underpriced", "FEE_CAP_TOO_LOW"],
    ["insufficient funds for gas * price + value", "INSUFFICIENT_GAS"],
    ["gas required exceeds allowance (0)", "GAS_CAP"],
  ] as const)("node message %j → %s", (msg, code) => {
    expect(classifyError(new InternalRpcError(new Error(msg))).code).toBe(code);
  });

  it("transport failures → RPC_UNAVAILABLE (unknown → reconciler)", () => {
    const http = new HttpRequestError({
      url: "http://127.0.0.1:8545",
      status: 503,
      details: "Service Unavailable",
    });
    expect(classifyError(http).code).toBe("RPC_UNAVAILABLE");
    expect(classifyError(new TimeoutError({ body: {}, url: "http://127.0.0.1:8545" })).code).toBe(
      "RPC_UNAVAILABLE",
    );
    expect(classifyError(new TypeError("fetch failed")).code).toBe("RPC_UNAVAILABLE");
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    expect(classifyError(refused).code).toBe("RPC_UNAVAILABLE");
    expect(EXEC_ERROR_OUTCOME.RPC_UNAVAILABLE).toBe("unknown");
  });

  it("receipt timeouts → RECEIPT_TIMEOUT", () => {
    const e = classifyError(new WaitForTransactionReceiptTimeoutError({ hash: ID }));
    expect(e.code).toBe("RECEIPT_TIMEOUT");
  });

  it("an ExecError passes through untouched; anything else is UNKNOWN, never success", () => {
    const x = new ExecError("SIGNER_MISMATCH", "boom");
    expect(classifyError(x)).toBe(x);
    expect(classifyError(new Error("something odd")).code).toBe("UNKNOWN");
    expect(classifyError("a string").code).toBe("UNKNOWN");
  });

  it("simulation context turns RPC trouble into SIM_TRANSIENT (next tick)", () => {
    const http = new HttpRequestError({ url: "http://127.0.0.1:8545", status: 429 });
    expect(classifySimulationError(http).code).toBe("SIM_TRANSIENT");
    expect(classifySimulationError(viemCallRevert(outsideFence)).code).toBe("SIM_POLICY");
  });
});

describe("classifySignerError (Dynamic)", () => {
  const apiError = (status: number, message: string, code?: string) =>
    Object.assign(new Error(message), {
      name: "WalletApiError",
      status,
      ...(code ? { code } : {}),
    });

  it("a 403 or a policy denial → SIGNER_DENIED → policy_denied", () => {
    const a = classifySignerError(apiError(403, "Forbidden"));
    expect(a.code).toBe("SIGNER_DENIED");
    expect(a.outcome).toBe("policy_denied");
    expect(
      classifySignerError(new Error("Transaction denied by policy rule 4663-allowlist")).code,
    ).toBe("SIGNER_DENIED");
    expect(classifySignerError(apiError(400, "rejected", "POLICY_VIOLATION")).code).toBe(
      "SIGNER_DENIED",
    );
    const axiosLike = Object.assign(new Error("Request failed"), {
      response: { status: 422, data: { error_code: "policy_denied" } },
    });
    expect(classifySignerError(axiosLike).code).toBe("SIGNER_DENIED");
  });

  it("a dead delegation → SIGNER_REVOKED → revoked", () => {
    const e = classifySignerError(apiError(401, "delegation revoked for wallet"));
    expect(e.code).toBe("SIGNER_REVOKED");
    expect(e.outcome).toBe("revoked");
  });

  it("everything else fails closed as SIGNER_UNAVAILABLE (one retry)", () => {
    expect(classifySignerError(apiError(503, "Service Unavailable")).code).toBe(
      "SIGNER_UNAVAILABLE",
    );
    expect(classifySignerError(apiError(0, "Network error - no response received")).code).toBe(
      "SIGNER_UNAVAILABLE",
    );
    expect(classifySignerError(new Error("mpc relay closed")).code).toBe("SIGNER_UNAVAILABLE");
    expect(EXEC_ERROR_OUTCOME.SIGNER_UNAVAILABLE).toBe("retry_once");
  });
});
