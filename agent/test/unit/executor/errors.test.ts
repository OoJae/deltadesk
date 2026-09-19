import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type AbiParameter,
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
import { CONTRACTS_ABI_DIR, EXTRAS_SECTIONS } from "../../../scripts/abi-sync.js";
import { deskLaneAbi } from "../../../src/executor/abi/DeskLane.js";
import { deskLaneFactoryAbi } from "../../../src/executor/abi/DeskLaneFactory.js";
import {
  classifyError,
  classifyRevert,
  classifySignerError,
  classifySimulationError,
  decodeRevert,
  FACTORY_ERROR_NAMES,
  FENCE_ERROR_NAMES,
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
      source: "lane",
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

/** A zero value for each parameter type (enough to encode any error the contracts declare). */
function zeroOf(p: AbiParameter): unknown {
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (p.type === "bool") return false;
  if (/^u?int\d*$/.test(p.type)) return 0n;
  if (/^bytes\d+$/.test(p.type)) return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  if (p.type === "tuple" && "components" in p) return p.components.map(zeroOf);
  throw new Error(`no zero value for ${p.type}`);
}

type AbiError = Extract<Abi[number], { type: "error" }>;

const extras = JSON.parse(readFileSync(join(CONTRACTS_ABI_DIR, "extras.json"), "utf8")) as Record<
  (typeof EXTRAS_SECTIONS)[number],
  Array<{ type: string }>
>;
const extraErrors = EXTRAS_SECTIONS.flatMap((section) =>
  (extras[section].filter((i) => i.type === "error") as AbiError[]).map(
    (e) => [section, e] as const,
  ),
);

describe("implementation-only errors (contracts/abi/extras.json)", () => {
  it("there are some, from each contract that declares them", () => {
    expect(extraErrors.map(([, e]) => e.name)).toEqual(
      expect.arrayContaining([
        "ReentrancyGuardReentrantCall",
        "SafeERC20FailedOperation",
        "LaneExists",
        "ImplementationTimelocked",
        "NoPendingImplementation",
        "BadConfig",
      ]),
    );
  });

  it.each(extraErrors.map(([section, e]) => [e.name, section, e] as const))(
    "%s decodes by name as the %s's error (never SIM_POLICY 'unknown revert')",
    (name, section, e) => {
      const data = encodeErrorResult({
        abi: [e],
        errorName: e.name,
        args: e.inputs.map(zeroOf) as never,
      });
      expect(decodeRevert(data)).toMatchObject({ errorName: name, source: section });
      const names = {
        lane: LANE_ERROR_NAMES,
        factory: FACTORY_ERROR_NAMES,
        fence: FENCE_ERROR_NAMES,
      };
      expect(names[section].has(name)).toBe(true);
      const c = classifyError(viemCallRevert(data));
      expect(c.message).toContain(`${section} reverted: ${name}`);
      expect(c.message).not.toMatch(/unknown revert/);
    },
  );

  it("a reentrant call and a refusing token fail closed (SIM_POLICY, no retry) with a plain reason", () => {
    const reentrant = classifyError(
      viemCallRevert(
        encodeErrorResult({ abi: deskLaneAbi, errorName: "ReentrancyGuardReentrantCall" }),
      ),
    );
    expect(reentrant.code).toBe("SIM_POLICY");
    expect(reentrant.outcome).toBe("fail");
    expect(reentrant.message).toMatch(/re-entered the lane/);
    const token = "0x2222222222222222222222222222222222222222";
    const refused = classifySimulationError(
      viemCallRevert(
        encodeErrorResult({
          abi: deskLaneAbi,
          errorName: "SafeERC20FailedOperation",
          args: [token],
        }),
      ),
    );
    expect(refused.code).toBe("SIM_POLICY");
    expect(refused.message).toContain(token);
    expect(refused.message).toMatch(/refused a transfer or approval/);
    expect((refused.detail as { errorName: string }).errorName).toBe("SafeERC20FailedOperation");
  });

  it("factory-side LaneExists and ImplementationTimelocked are recognised by name", () => {
    const lane = "0x1111111111111111111111111111111111111111";
    const exists = classifyRevert(
      encodeErrorResult({ abi: deskLaneFactoryAbi, errorName: "LaneExists", args: [lane] }),
      null,
    );
    expect(exists.code).toBe("SIM_POLICY");
    expect(exists.message).toMatch(/^factory reverted: LaneExists \(/);
    expect(exists.message).toContain(lane);
    expect(exists.detail).toMatchObject({ errorName: "LaneExists", source: "factory" });
    const locked = classifyRevert(
      encodeErrorResult({
        abi: deskLaneFactoryAbi,
        errorName: "ImplementationTimelocked",
        args: [1, 1_790_000_000n],
      }),
      null,
    );
    expect(locked.message).toMatch(/kind-1 implementation change is timelocked until 1790000000/);
    // The frozen factory errors decode as the factory's too.
    expect(
      decodeRevert(encodeErrorResult({ abi: deskLaneFactoryAbi, errorName: "NotAdmin" })),
    ).toMatchObject({ errorName: "NotAdmin", source: "factory" });
  });

  it("Error(string) is the solidity built-in, still SIM_POLICY", () => {
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }],
      errorName: "Error",
      args: ["STF"],
    });
    expect(decodeRevert(data)).toMatchObject({ errorName: "Error", source: "solidity" });
    expect(classifyError(viemCallRevert(data)).code).toBe("SIM_POLICY");
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
