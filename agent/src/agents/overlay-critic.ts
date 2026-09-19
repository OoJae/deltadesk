/**
 * LLM overlay critic (OFF in M2): an independent second model that must APPROVE an overlay before
 * it is even tighten-checked.
 *
 * FAIL-CLOSED BY CONSTRUCTION: output that fails validation after the retry budget, and any
 * transport error, resolve to REJECT rather than a throw, so no caller can mistake a failure for
 * "no objection". The one exception is LlmCreditsExhausted (HTTP 402), which propagates so the
 * daemon can switch to deterministic mode; the overlay stage treats it as REJECT as well.
 */

import {
  type CritiqueResult,
  type LlmClient,
  LlmCreditsExhausted,
  type OverlayCritic,
} from "../types.js";
import { buildOverlayCriticPrompt } from "./prompts.js";
import { CriticVerdictSchema, completeWithSchema, SchemaValidationError } from "./schemas.js";

export type { CriticVerdict, CritiqueResult, OverlayCritic } from "../types.js";

export function createOverlayCritic(
  llm: LlmClient,
  opts: { maxAttempts?: number } = {},
): OverlayCritic {
  return {
    async critique(ctx, proposal): Promise<CritiqueResult> {
      try {
        const { value, raw } = await completeWithSchema(
          llm,
          buildOverlayCriticPrompt(ctx.plan, ctx.regime, proposal),
          CriticVerdictSchema,
          opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts },
        );
        return { verdict: value, raw };
      } catch (err) {
        if (err instanceof LlmCreditsExhausted) throw err;
        if (err instanceof SchemaValidationError) {
          return {
            verdict: {
              verdict: "REJECT",
              reason: `critic output failed validation after ${err.attempts} attempt(s); rejecting fail-closed`,
            },
            raw: err.rawOutputs[err.rawOutputs.length - 1] ?? null,
          };
        }
        return {
          verdict: {
            verdict: "REJECT",
            reason: `critic unavailable (${err instanceof Error ? err.message : String(err)}); rejecting fail-closed`,
          },
          raw: null,
        };
      }
    },
  };
}
