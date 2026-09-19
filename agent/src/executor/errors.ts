/**
 * Error taxonomy (docs/m2-design-agent.md "Error taxonomy"): every failure on the execution path
 * becomes an ExecError whose code maps to one outcome (EXEC_ERROR_OUTCOME in types.ts).
 *
 * viem errors are classified by walking their cause chain (`BaseError.walk()`): the first revert
 * payload found is decoded by name against every DeltaDesk custom error (the lane's, the factory's
 * and the fence's, implementation-only ones included: contracts/abi/extras.json via abi-sync) plus
 * Error(string) and Panic(uint256); otherwise the node's message and the transport error class
 * decide. Anything unrecognised is UNKNOWN (→ reconciler), never a success.
 *
 * Decoded reverts: DecisionUsed → SIM_DECISION_USED (reconcile); every other custom error is
 * SIM_POLICY (failed, never retried), named, with a plain reason for the ones that are not
 * self-explanatory (a reentrant call, a token that refused a transfer, the factory's LaneExists /
 * ImplementationTimelocked). An undecodable revert is still SIM_POLICY: fail closed.
 *
 * Signer errors (Dynamic) are classified separately (classifySignerError): a policy denial is
 * SIGNER_DENIED (→ policy_denied + safe mode), a dead delegation is SIGNER_REVOKED, and everything
 * else fails closed as SIGNER_UNAVAILABLE (one retry, then the step fails).
 */

import {
  type Abi,
  BaseError,
  ChainDisconnectedError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  ExecutionRevertedError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import {
  type ErrorClassifier,
  ExecError,
  type ExecErrorCode,
  type Hex,
  isExecError,
} from "../types.js";
import { deskLaneAbi } from "./abi/DeskLane.js";
import { deskLaneFactoryAbi } from "./abi/DeskLaneFactory.js";
import { priceFenceAbi } from "./abi/PriceFence.js";

export type { ErrorClassifier, ExecErrorCode, ExecErrorOutcome } from "../types.js";

/** Which DeltaDesk contract declares a decoded error; `solidity` is Error(string) / Panic(uint256). */
export type RevertSource = "lane" | "factory" | "fence" | "solidity";

type ErrorItem = Extract<Abi[number], { type: "error" }>;

const errorsOf = (abi: Abi): ErrorItem[] => abi.filter((i): i is ErrorItem => i.type === "error");

/** The lane's custom error names (from the generated ABI, implementation-only ones included). */
export const LANE_ERROR_NAMES: ReadonlySet<string> = new Set(
  errorsOf(deskLaneAbi).map((i) => i.name),
);
/** The factory's custom error names (LaneExists, ImplementationTimelocked, …). */
export const FACTORY_ERROR_NAMES: ReadonlySet<string> = new Set(
  errorsOf(deskLaneFactoryAbi).map((i) => i.name),
);
/** The fence's custom error names (BadConfig; status() and usdPrice() never revert). */
export const FENCE_ERROR_NAMES: ReadonlySet<string> = new Set(
  errorsOf(priceFenceAbi).map((i) => i.name),
);

/** Decoding order: a signature both contracts declare decodes as the lane's. */
const DECODE_ORDER: ReadonlyArray<readonly [RevertSource, Abi]> = [
  ["lane", deskLaneAbi],
  ["factory", deskLaneFactoryAbi],
  ["fence", priceFenceAbi],
  ["solidity", []], // decodeErrorResult always knows Error(string) and Panic(uint256)
];

/**
 * Plain reasons for errors whose name alone does not tell an operator what happened. Every one of
 * them stays SIM_POLICY: failed, never retried (the next tick plans from fresh state).
 */
const REVERT_REASONS: Readonly<Record<string, (args: readonly unknown[]) => string>> = {
  ReentrancyGuardReentrantCall: () =>
    "a call re-entered the lane mid-action (a token or pool hook); refused, never retried",
  SafeERC20FailedOperation: (a) =>
    `token ${String(a[0])} refused a transfer or approval (paused or blocklisted?)`,
  MarketClosed: (a) => `the fence is closed to risk-adding (code ${String(a[0])})`,
  LaneExists: (a) =>
    `a lane with these parameters already exists at ${String(a[0])}; only its owner's own createLane lists it`,
  ImplementationTimelocked: (a) =>
    `the factory's kind-${String(a[0])} implementation change is timelocked until ${String(a[1])}`,
  NoPendingImplementation: (a) => `no implementation change is pending for kind ${String(a[0])}`,
};

export interface DecodedRevert {
  errorName: string;
  args: readonly unknown[];
  source: RevertSource;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

function hexData(v: unknown): Hex | null {
  if (typeof v === "string" && HEX_RE.test(v) && v.length >= 10) return v as Hex;
  if (typeof v === "object" && v !== null && "data" in v)
    return hexData((v as { data: unknown }).data);
  return null;
}

/** Every error in a cause chain, outermost first (viem BaseErrors and plain Error causes alike). */
export function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 16 && cur !== undefined && cur !== null; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** Revert bytes on one error: `data` (RPC errors, RawContractError) or `raw` (ContractFunctionRevertedError). */
function ownRevertData(e: unknown): Hex | null {
  if (typeof e !== "object" || e === null) return null;
  const r = e as { data?: unknown; raw?: unknown };
  return hexData(r.data) ?? hexData(r.raw);
}

/** The revert payload carried anywhere in the chain (the same place viem's getRevertErrorData looks). */
export function revertDataOf(err: unknown): Hex | null {
  if (err instanceof BaseError) {
    const found = err.walk((e) => ownRevertData(e) !== null);
    if (found !== null) return ownRevertData(found);
  }
  for (const e of errorChain(err)) {
    const d = ownRevertData(e);
    if (d !== null) return d;
  }
  return null;
}

/**
 * Decode a revert payload by name: every lane, factory and fence custom error, Error(string) and
 * Panic(uint256). Null when the selector is none of them.
 */
export function decodeRevert(data: Hex): DecodedRevert | null {
  for (const [source, abi] of DECODE_ORDER) {
    try {
      const r = decodeErrorResult({ abi, data });
      const declared = errorsOf(abi).some((e) => e.name === r.errorName);
      return {
        errorName: r.errorName,
        args: (r.args ?? []) as readonly unknown[],
        source: declared ? source : "solidity",
      };
    } catch {
      /* not this contract's error */
    }
  }
  return null;
}

/** A one-line description of a decoded revert: `<contract> reverted: <Error>[ (reason)]`. */
export function describeRevert(decoded: DecodedRevert | null): string {
  if (decoded === null) return "lane reverted: unknown revert";
  const who = decoded.source === "solidity" ? "lane" : decoded.source;
  const reason = REVERT_REASONS[decoded.errorName]?.(decoded.args);
  return `${who} reverted: ${decoded.errorName}${reason === undefined ? "" : ` (${reason})`}`;
}

/** All human-readable text of a chain (message, shortMessage, details), for node-message matching. */
function chainText(err: unknown): string {
  const parts: string[] = [];
  for (const e of errorChain(err)) {
    if (typeof e === "string") parts.push(e);
    if (typeof e !== "object" || e === null) continue;
    for (const k of ["shortMessage", "details", "message", "code"] as const) {
      const v = (e as Record<string, unknown>)[k];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join(" | ");
}

/**
 * Node messages (geth/nitro wording, the same patterns viem's node errors match), in priority order.
 * "already known" means the node already holds these exact bytes: the executor looks the hash up.
 */
const NODE_MESSAGES: ReadonlyArray<readonly [RegExp, ExecErrorCode]> = [
  [/already known|known transaction|transaction already imported/i, "NONCE_TOO_LOW"],
  [/nonce too low|nonce has already been used/i, "NONCE_TOO_LOW"],
  [/nonce too high|nonce gap/i, "NONCE_CONFLICT"],
  [
    /max fee per gas less than block base fee|fee cap less than block base fee|transaction underpriced|transaction is outdated/i,
    "FEE_CAP_TOO_LOW",
  ],
  [
    /insufficient funds|exceeds transaction sender account balance|insufficient balance/i,
    "INSUFFICIENT_GAS",
  ],
  [/gas required exceeds allowance|exceeds block gas limit|intrinsic gas too/i, "GAS_CAP"],
];

const TRANSPORT_CODES = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/;

function isTransportError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (
      e instanceof HttpRequestError ||
      e instanceof TimeoutError ||
      e instanceof LimitExceededRpcError ||
      e instanceof ResourceUnavailableRpcError ||
      e instanceof InternalRpcError ||
      e instanceof SocketClosedError ||
      e instanceof ChainDisconnectedError ||
      e instanceof RpcRequestError
    ) {
      return true;
    }
    if (e instanceof Error) {
      if (e.name === "AbortError" || e.name === "TimeoutError") return true;
      if (/fetch failed|network|socket hang up/i.test(e.message)) return true;
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && TRANSPORT_CODES.test(code)) return true;
    }
  }
  return false;
}

function messageOf(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage || err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Classify a revert payload (simulation, estimateGas, or the replayed call of a reverted tx). */
export function classifyRevert(data: Hex | null, cause: unknown): ExecError {
  const decoded = data === null ? null : decodeRevert(data);
  if (decoded?.errorName === "DecisionUsed") {
    return new ExecError("SIM_DECISION_USED", "decisionId already used on-chain", {
      cause,
      detail: decoded,
    });
  }
  return new ExecError("SIM_POLICY", describeRevert(decoded), {
    cause,
    detail: decoded ?? { errorName: null, args: [], data },
  });
}

/** executor/errors.ts: the ErrorClassifier (viem err.walk() + node messages + transport classes). */
export const classifyError: ErrorClassifier = (err) => {
  if (isExecError(err)) return err;
  const message = messageOf(err);

  const data = revertDataOf(err);
  if (data !== null) return classifyRevert(data, err);
  if (
    err instanceof BaseError &&
    err.walk(
      (e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError,
    ) !== null
  ) {
    return classifyRevert(null, err);
  }

  if (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof WaitForTransactionReceiptTimeoutError ||
        e instanceof TransactionReceiptNotFoundError,
    ) !== null
  ) {
    return new ExecError("RECEIPT_TIMEOUT", message, { cause: err });
  }

  const text = chainText(err);
  for (const [re, code] of NODE_MESSAGES) {
    if (re.test(text)) return new ExecError(code, message, { cause: err });
  }
  if (/execution reverted|revert/i.test(text)) return classifyRevert(null, err);

  if (isTransportError(err)) return new ExecError("RPC_UNAVAILABLE", message, { cause: err });
  return new ExecError("UNKNOWN", message, { cause: err });
};

/** Simulation context: an RPC failure is transient (next tick), not an unknown tx state. */
export function classifySimulationError(err: unknown): ExecError {
  const e = classifyError(err);
  if (e.code === "RPC_UNAVAILABLE" || e.code === "UNKNOWN" || e.code === "RECEIPT_TIMEOUT") {
    return new ExecError("SIM_TRANSIENT", e.message, { cause: err, detail: e.detail });
  }
  return e;
}

// ---------------------------------------------------------------------------------------------
// Signers

function statusOf(err: unknown): number | null {
  for (const e of errorChain(err)) {
    if (typeof e !== "object" || e === null) continue;
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
    const r = (e as { response?: { status?: unknown } }).response;
    if (typeof r?.status === "number") return r.status;
  }
  return null;
}

function serverCodeOf(err: unknown): string {
  const codes: string[] = [];
  for (const e of errorChain(err)) {
    if (typeof e !== "object" || e === null) continue;
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") codes.push(c);
    const data = (e as { response?: { data?: Record<string, unknown> } }).response?.data;
    for (const k of ["code", "error_code", "error"]) {
      const v = data?.[k];
      if (typeof v === "string") codes.push(v);
    }
  }
  return codes.join(" ");
}

const POLICY_DENIAL =
  /polic(y|ies)[\s_-]*(den|violat|reject|block|fail)|not allowed by (the )?polic|denied by (the )?polic|policy_?denied|policy_?violation/i;
const DELEGATION_GONE = /delegation.*(revoked|not found|expired|inactive)|revoked/i;

/**
 * Dynamic signer failures. The exact denial payload is confirmed in the sandbox spike (S1); until
 * then a 403, or any message/code naming a policy denial, counts as SIGNER_DENIED, which fails
 * closed into policy_denied + safe mode.
 */
export function classifySignerError(err: unknown): ExecError {
  if (isExecError(err)) return err;
  const message = messageOf(err);
  const status = statusOf(err);
  const text = `${chainText(err)} ${serverCodeOf(err)}`;
  if (status === 403 || POLICY_DENIAL.test(text)) {
    return new ExecError("SIGNER_DENIED", `signer policy denied the transaction: ${message}`, {
      cause: err,
      detail: { status },
    });
  }
  if (DELEGATION_GONE.test(text) && (status === null || status === 401 || status === 404)) {
    return new ExecError("SIGNER_REVOKED", `delegation is no longer usable: ${message}`, {
      cause: err,
      detail: { status },
    });
  }
  return new ExecError("SIGNER_UNAVAILABLE", `signer unavailable: ${message}`, {
    cause: err,
    detail: { status },
  });
}
