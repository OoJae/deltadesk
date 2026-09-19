/**
 * Signer contract (the Operator wallet, never the owner) and the checks every signature passes
 * before the executor persists or broadcasts it.
 *
 * verifySignedTx is the executor's step 7: the signed bytes must parse back to EXACTLY the request
 * (type, chain, to, data, value, nonce, gas, fees, empty access list) and must recover to the
 * signer's address. A remote signer (Dynamic MPC) that returns anything else, including a valid
 * signature over a different transaction, is SIGNER_MISMATCH and nothing is stored or sent.
 */

import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559,
} from "viem";
import { type Address, ExecError, type Hex, type TxSigner, type UnsignedTx } from "../types.js";

export type { SignerKind, SignerReadiness, TxSigner, UnsignedTx } from "../types.js";

/** The request in viem's serializable shape (what every signer signs). */
export function toViemTx(tx: UnsignedTx): TransactionSerializableEIP1559 {
  return {
    type: "eip1559",
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    nonce: tx.nonce,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  };
}

export interface VerifiedTx {
  hash: Hex;
  recovered: Address;
}

function mismatch(message: string, detail?: unknown): ExecError {
  return new ExecError("SIGNER_MISMATCH", `signed bytes rejected: ${message}`, { detail });
}

export async function verifySignedTx(
  raw: Hex,
  request: UnsignedTx,
  signer: Address,
): Promise<VerifiedTx> {
  if (typeof raw !== "string" || !/^0x02[0-9a-fA-F]+$/.test(raw))
    throw mismatch("not an EIP-1559 (type 2) serialized transaction");
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(raw);
  } catch (err) {
    throw mismatch(`unparseable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems: string[] = [];
  const eq = (field: string, got: unknown, want: unknown) => {
    if (got !== want) problems.push(`${field}: got ${String(got)}, want ${String(want)}`);
  };
  eq("type", parsed.type, "eip1559");
  eq("chainId", parsed.chainId, request.chainId);
  eq("to", parsed.to?.toLowerCase(), request.to.toLowerCase());
  eq("data", (parsed.data ?? "0x").toLowerCase(), request.data.toLowerCase());
  eq("value", parsed.value ?? 0n, request.value);
  eq("nonce", parsed.nonce ?? 0, request.nonce);
  eq("gas", parsed.gas ?? 0n, request.gas);
  eq("maxFeePerGas", parsed.maxFeePerGas ?? 0n, request.maxFeePerGas);
  eq("maxPriorityFeePerGas", parsed.maxPriorityFeePerGas ?? 0n, request.maxPriorityFeePerGas);
  const accessList = (parsed as { accessList?: readonly unknown[] }).accessList;
  if (accessList !== undefined && accessList.length > 0) problems.push("non-empty access list");
  if (parsed.r === undefined || parsed.s === undefined || parsed.yParity === undefined)
    problems.push("missing signature");
  if (problems.length > 0) throw mismatch(problems.join("; "), { problems });

  let recovered: Address;
  try {
    recovered = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerializedEIP1559,
    });
  } catch (err) {
    throw mismatch(
      `signature does not recover: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (recovered.toLowerCase() !== signer.toLowerCase())
    throw mismatch(`recovered ${recovered}, expected the operator ${signer}`, { recovered });
  return { hash: keccak256(raw), recovered: recovered.toLowerCase() as Address };
}

/** Reject after `ms` with the error from `onTimeout` (the underlying call is abandoned, not cancelled). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Sign with a timeout; a slow signer is SIGNER_UNAVAILABLE (never a partial result). */
export function signWithTimeout(signer: TxSigner, tx: UnsignedTx, ms: number): Promise<Hex> {
  return withTimeout(
    signer.signTransaction(tx),
    ms,
    () => new ExecError("SIGNER_UNAVAILABLE", `${signer.kind} signer timed out after ${ms} ms`),
  );
}
