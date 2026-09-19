/**
 * Anthropic-protocol LlmClient pointed at the Bankr LLM gateway (baseURL https://llm.bankr.bot,
 * apiKey bk_…). The LLM is never on the execution path: it can only propose a tighten-only overlay,
 * which is off by default in M2.
 *
 * HTTP 402 (billing_error: credits exhausted) becomes LlmCreditsExhausted, which the daemon turns
 * into deterministic mode (identity overlay). createCreditsBreaker keeps that decision for a
 * cooldown so an exhausted account is not hammered every tick.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Clock, type LlmClient, LlmCreditsExhausted, type LlmRequest } from "../types.js";

export interface BankrLlmOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Per-request timeout; a tick must not hang on the overlay. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export function isCreditsExhausted(err: unknown): boolean {
  return err instanceof Anthropic.APIError && (err.status === 402 || err.type === "billing_error");
}

export function createBankrLlm(opts: BankrLlmOptions): LlmClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    timeout: opts.timeoutMs ?? 20_000,
    maxRetries: opts.maxRetries ?? 1,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });

  return {
    async complete(req: LlmRequest): Promise<string> {
      try {
        const response = await client.messages.create({
          model: opts.model,
          max_tokens: req.maxTokens ?? 2_048,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
        if (response.stop_reason === "refusal")
          throw new Error("LLM declined the request (stop_reason refusal)");
        return response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
      } catch (err) {
        if (isCreditsExhausted(err)) throw new LlmCreditsExhausted(undefined, { cause: err });
        throw err;
      }
    },
  };
}

export interface CreditsBreakerOptions {
  clock: Clock;
  /** How long to stay deterministic after a 402 before trying the gateway again. */
  cooldownMs?: number;
  onExhausted?: (untilMs: number) => void;
}

/** After a 402, fail fast with LlmCreditsExhausted until the cooldown passes. */
export function createCreditsBreaker(
  inner: LlmClient,
  opts: CreditsBreakerOptions,
): LlmClient & {
  exhaustedUntil(): number | null;
} {
  const cooldownMs = opts.cooldownMs ?? 3_600_000;
  let until: number | null = null;
  return {
    exhaustedUntil: () => until,
    async complete(req) {
      const now = opts.clock.now();
      if (until !== null && now < until)
        throw new LlmCreditsExhausted("LLM credits exhausted (breaker open)");
      try {
        const out = await inner.complete(req);
        until = null;
        return out;
      } catch (err) {
        if (err instanceof LlmCreditsExhausted) {
          until = now + cooldownMs;
          opts.onExhausted?.(until);
        }
        throw err;
      }
    },
  };
}
