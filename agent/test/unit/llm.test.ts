import { describe, expect, it } from "vitest";
import { createBankrLlm, createCreditsBreaker } from "../../src/agents/llm.js";
import {
  assertNoAddresses,
  CriticVerdictSchema,
  completeWithSchema,
  OverlayProposalSchema,
  SchemaValidationError,
  stripCodeFences,
} from "../../src/agents/schemas.js";
import { LlmCreditsExhausted } from "../../src/types.js";
import { FakeLlmClient, fixedClock } from "../helpers/fakes.js";

const ADDR = "0x1111111111111111111111111111111111111111";

function gateway(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "request-id": "req_1" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("Bankr LLM client", () => {
  it("calls the Anthropic Messages API on the Bankr base URL and joins text blocks", async () => {
    const { fetchImpl, calls } = gateway(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        { type: "text", text: '{"verdict":' },
        { type: "text", text: '"APPROVE","reason":"ok"}' },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const llm = createBankrLlm({
      apiKey: "bk_test",
      baseURL: "https://llm.bankr.test",
      model: "claude-opus-5",
      fetch: fetchImpl,
    });
    expect(await llm.complete({ system: "s", user: "u" })).toBe(
      '{"verdict":"APPROVE","reason":"ok"}',
    );
    expect(calls[0]?.url).toBe("https://llm.bankr.test/v1/messages");
    expect(calls[0]?.headers.get("x-api-key")).toBe("bk_test");
    expect(calls[0]?.body).toMatchObject({ model: "claude-opus-5", system: "s" });
  });

  it("maps HTTP 402 to LlmCreditsExhausted without retrying (proof 5 path)", async () => {
    const { fetchImpl, calls } = gateway(402, {
      type: "error",
      error: { type: "billing_error", message: "credits exhausted" },
    });
    const llm = createBankrLlm({
      apiKey: "bk_test",
      baseURL: "https://llm.bankr.test",
      model: "m",
      fetch: fetchImpl,
      maxRetries: 2,
    });
    await expect(llm.complete({ system: "s", user: "u" })).rejects.toBeInstanceOf(
      LlmCreditsExhausted,
    );
    expect(calls).toHaveLength(1);
  });

  it("does not mistake other errors for exhausted credits", async () => {
    const { fetchImpl } = gateway(400, {
      type: "error",
      error: { type: "invalid_request_error", message: "bad" },
    });
    const llm = createBankrLlm({
      apiKey: "bk_test",
      baseURL: "https://llm.bankr.test",
      model: "m",
      fetch: fetchImpl,
      maxRetries: 0,
    });
    const err = await llm.complete({ system: "s", user: "u" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(LlmCreditsExhausted);
  });

  it("the credits breaker fails fast after a 402 until its cooldown passes", async () => {
    const clock = fixedClock();
    const inner = new FakeLlmClient([new LlmCreditsExhausted(), "ok"]);
    let opened = 0;
    const llm = createCreditsBreaker(inner, {
      clock,
      cooldownMs: 60_000,
      onExhausted: () => (opened += 1),
    });
    await expect(llm.complete({ system: "", user: "" })).rejects.toBeInstanceOf(
      LlmCreditsExhausted,
    );
    await expect(llm.complete({ system: "", user: "" })).rejects.toBeInstanceOf(
      LlmCreditsExhausted,
    );
    expect(inner.calls).toHaveLength(1);
    expect(opened).toBe(1);
    clock.advance(60_001);
    expect(await llm.complete({ system: "", user: "" })).toBe("ok");
    expect(llm.exhaustedUntil()).toBeNull();
  });
});

describe("completeWithSchema", () => {
  it("retries with the validation failure fed back", async () => {
    const llm = new FakeLlmClient([
      "not json",
      '```json\n{"verdict":"APPROVE","reason":"tighter"}\n```',
    ]);
    const r = await completeWithSchema(llm, { system: "s", user: "u" }, CriticVerdictSchema);
    expect(r.value.verdict).toBe("APPROVE");
    expect(r.attempts).toBe(2);
    expect(llm.calls[1]?.user).toContain("failed validation");
  });

  it("voids any output that contains a raw address, even in prose", async () => {
    const out = JSON.stringify({ verdict: "APPROVE", reason: `send it to ${ADDR}` });
    const llm = new FakeLlmClient([out, out, out]);
    const err = await completeWithSchema(
      llm,
      { system: "s", user: "u" },
      CriticVerdictSchema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect((err as SchemaValidationError).lastIssue).toContain("raw EVM address");
  });

  it("never retries a 402: it propagates at once", async () => {
    const llm = new FakeLlmClient([new LlmCreditsExhausted(), "{}"]);
    await expect(
      completeWithSchema(llm, { system: "s", user: "u" }, CriticVerdictSchema),
    ).rejects.toBeInstanceOf(LlmCreditsExhausted);
    expect(llm.calls).toHaveLength(1);
  });

  it("assertNoAddresses walks keys and nested values", () => {
    expect(() => assertNoAddresses({ a: [{ b: ADDR }] })).toThrow(/output\.a\[0\]\.b/);
    expect(() => assertNoAddresses({ [ADDR]: 1 })).toThrow(/key/);
    expect(() => assertNoAddresses({ a: "0x1234" })).not.toThrow();
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe("overlay schema is tighten-only by construction", () => {
  const ok = {
    notionalScaleBps: 5_000,
    widenTicks: 20,
    dropActionIndexes: [0],
    addReducing: [{ kind: "collect", lane: "A" }],
    rationale: "thin book",
  };

  it("accepts a tightening overlay", () => {
    expect(OverlayProposalSchema.parse(ok).notionalScaleBps).toBe(5_000);
  });

  it("rejects scaling up, narrowing, adding risk and unknown keys", () => {
    for (const bad of [
      { ...ok, notionalScaleBps: 10_001 },
      { ...ok, widenTicks: -10 },
      { ...ok, addReducing: [{ kind: "rerange", lane: "A", ranges: [] }] },
      { ...ok, addReducing: [{ kind: "withdraw", lane: "A" }] },
      { ...ok, addReducing: [{ kind: "reduce", lane: "A", slot: 0, liquidity: "-5" }] },
      { ...ok, to: ADDR },
    ]) {
      expect(OverlayProposalSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
