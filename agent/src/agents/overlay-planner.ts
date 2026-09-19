/**
 * LLM overlay planner (OFF in M2). Asks the model for a tighten-only OverlayProposal against the
 * VERIFIED FIGURES of the deterministic plan, validated strictly (OverlayProposalSchema, no raw
 * addresses, retry with feedback).
 *
 * It throws on any failure (bad output after retries, transport errors, LlmCreditsExhausted); the
 * overlay stage (overlay/apply.ts resolveOverlay) turns every throw into the identity overlay and a
 * 402 into deterministic mode. Nothing it returns is trusted: the critic and the tighten-check still
 * stand between it and the plan.
 */

import type {
  LlmClient,
  OverlayContext,
  OverlayPlanner,
  OverlayProposal,
  ReducingAction,
} from "../types.js";
import { buildOverlayPlannerPrompt } from "./prompts.js";
import { completeWithSchema, OverlayProposalSchema, type OverlayProposalWire } from "./schemas.js";

export type { OverlayContext, OverlayPlanner, OverlayProposal } from "../types.js";

/** JSON has no bigint: reduce liquidity arrives as a decimal string. */
export function proposalFromWire(wire: OverlayProposalWire): OverlayProposal {
  const addReducing: ReducingAction[] = wire.addReducing.map((a) =>
    a.kind === "reduce"
      ? { kind: "reduce", lane: a.lane, slot: a.slot, liquidity: BigInt(a.liquidity) }
      : { ...a },
  );
  return {
    notionalScaleBps: wire.notionalScaleBps,
    widenTicks: wire.widenTicks,
    dropActionIndexes: [...new Set(wire.dropActionIndexes)].sort((x, y) => x - y),
    addReducing,
    rationale: wire.rationale,
  };
}

export interface OverlayPlannerOptions {
  maxAttempts?: number;
  maxTokens?: number;
}

export function createOverlayPlanner(
  llm: LlmClient,
  opts: OverlayPlannerOptions = {},
): OverlayPlanner {
  return {
    async propose(ctx: OverlayContext) {
      const { value, raw } = await completeWithSchema(
        llm,
        buildOverlayPlannerPrompt(ctx.plan, ctx.regime),
        OverlayProposalSchema,
        {
          ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
          ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
        },
      );
      return { proposal: proposalFromWire(value), raw };
    },
  };
}
