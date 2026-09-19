/**
 * Strict output schemas for the LLM agents and the reject-and-retry loop.
 *
 * Schemas are STRICT (unknown keys are rejected, never stripped): a hallucinated `to` field is
 * evidence of a bad generation, not noise. On top of the schema, assertNoAddresses() rejects any raw
 * EVM address anywhere in the output, prose included, because addresses come only from config.
 * An LlmCreditsExhausted (HTTP 402) is never retried: it propagates at once so the daemon can drop
 * to deterministic mode.
 */

import { z } from "zod";
import type { LlmClient } from "../types.js";

const RAW_ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

/**
 * Reject any raw EVM address in model output. One appearing even inside a rationale means the model
 * is trying to steer execution, and the whole output is void.
 */
export function assertNoAddresses(value: unknown, path = "output"): void {
  if (typeof value === "string") {
    if (RAW_ADDRESS_RE.test(value)) {
      throw new Error(`raw EVM address found in ${path}: addresses come only from config`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertNoAddresses(v, `${path}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assertNoAddresses(k, `${path} key`);
      assertNoAddresses(v, `${path}.${k}`);
    }
  }
}

export function containsRawAddress(s: string): boolean {
  return RAW_ADDRESS_RE.test(s);
}

// ---------------------------------------------------------------------------------------------
// Overlay schemas (src/types.ts OverlayProposal). Tighten-only by construction: scale ≤ 100%,
// widening ≥ 0, only reducing actions may be added.

const laneSchema = z.enum(["A", "B", "C"]);

export const ReducingActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reduce"),
    lane: laneSchema,
    slot: z.union([z.literal(0), z.literal(1)]),
    /** Decimal string: JSON has no bigint. Converted by the overlay applier. */
    liquidity: z.string().regex(/^[1-9]\d*$/),
  }),
  z.strictObject({ kind: z.literal("collect"), lane: laneSchema }),
  z.strictObject({ kind: z.literal("exitAll"), lane: laneSchema }),
  z.strictObject({ kind: z.literal("pause"), lane: laneSchema }),
]);

export const OverlayProposalSchema = z.strictObject({
  notionalScaleBps: z.number().int().min(0).max(10_000),
  widenTicks: z.number().int().min(0).max(2_000),
  dropActionIndexes: z.array(z.number().int().min(0).max(15)).max(16),
  addReducing: z.array(ReducingActionSchema).max(4),
  rationale: z.string().min(1).max(500),
});
export type OverlayProposalWire = z.infer<typeof OverlayProposalSchema>;

export const CriticVerdictSchema = z.strictObject({
  verdict: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().min(1).max(500),
});

// ---------------------------------------------------------------------------------------------

export class SchemaValidationError extends Error {
  constructor(
    readonly attempts: number,
    readonly rawOutputs: string[],
    readonly lastIssue: string,
  ) {
    super(`LLM output failed validation after ${attempts} attempt(s): ${lastIssue}`);
    this.name = "SchemaValidationError";
  }
}

/** Strip a ```json … ``` fence if present. This is the ONLY leniency in the pipeline. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export interface CompleteWithSchemaResult<T> {
  value: T;
  raw: string;
  attempts: number;
}

/**
 * Ask for JSON, validate strictly, and retry with the validation failure fed back into the prompt.
 * Throws SchemaValidationError once attempts are exhausted; callers pick the fail-safe posture
 * (overlay planner → identity overlay, critic → REJECT).
 */
export async function completeWithSchema<T>(
  llm: LlmClient,
  prompt: { system: string; user: string },
  schema: z.ZodType<T>,
  opts: { maxAttempts?: number; maxTokens?: number } = {},
): Promise<CompleteWithSchemaResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const rawOutputs: string[] = [];
  let user = prompt.user;
  let lastIssue = "no attempts made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Transport errors (LlmCreditsExhausted included) propagate at once: only bad OUTPUT is retried.
    const raw = await llm.complete({
      system: prompt.system,
      user,
      ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    });
    rawOutputs.push(raw);
    try {
      const parsed = schema.parse(JSON.parse(stripCodeFences(raw)));
      assertNoAddresses(parsed);
      return { value: parsed, raw, attempts: attempt };
    } catch (err) {
      lastIssue =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
          : String(err instanceof Error ? err.message : err);
      user =
        `${prompt.user}\n\nYour previous output failed validation: ${lastIssue}. ` +
        "Respond with only a corrected JSON object: no prose, no markdown, no addresses.";
    }
  }

  throw new SchemaValidationError(maxAttempts, rawOutputs, lastIssue);
}
