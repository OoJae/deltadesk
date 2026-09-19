/**
 * Error taxonomy (docs/m2-design-agent.md "Error taxonomy"): every failure on the execution path
 * becomes an ExecError whose code maps to one outcome (EXEC_ERROR_OUTCOME in types.ts).
 *
 * viem errors are classified by walking their cause chain (`BaseError.walk()`): the first revert
 * payload found is decoded against the lane's custom errors; otherwise the node's message and the
 * transport error class decide. Anything unrecognised is UNKNOWN (→ reconciler), never a success.
 *
 * Signer errors (Dynamic) are classified separately (classifySignerError): a policy denial is
 * SIGNER_DENIED (→ policy_denied + safe mode), a dead delegation is SIGNER_REVOKED, and everything
 * else fails closed as SIGNER_UNAVAILABLE (one retry, then the step fails).
 */

import {
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

export type { ErrorClassifier, ExecErrorCode, ExecErrorOutcome } from "../types.js";

/** The lane's custom error names (from the generated ABI). */
export const LANE_ERROR_NAMES: ReadonlySet<string> = new Set(
  deskLaneAbi.filter((i) => i.type === "error").map((i) => i.name),
);

export interface DecodedRevert {
  errorName: string;
  args: readonly unknown[];
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

/** Decode a revert payload: the lane's custom errors, Error(string) and Panic(uint256). */
export function decodeRevert(data: Hex): DecodedRevert | null {
  try {
    const r = decodeErrorResult({ abi: deskLaneAbi, data });
    return { errorName: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
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
  const name = decoded?.errorName ?? "unknown revert";
  return new ExecError("SIM_POLICY", `lane reverted: ${name}`, {
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
