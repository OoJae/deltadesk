import { describe, expect, it } from "vitest";
import { createOverlayCritic } from "../../../src/agents/overlay-critic.js";
import { createOverlayPlanner, proposalFromWire } from "../../../src/agents/overlay-planner.js";
import { SchemaValidationError } from "../../../src/agents/schemas.js";
import { IDENTITY_PROPOSAL } from "../../../src/overlay/apply.js";
import { LlmCreditsExhausted } from "../../../src/types.js";
import { FakeLlmClient } from "../../helpers/fakes.js";
import { validAddingStep } from "../guard/fixture.js";

function ctx() {
  const { snapshot, regime, plan } = validAddingStep();
  return { snapshot, regime, plan };
}

const proposal = JSON.stringify({
  notionalScaleBps: 5000,
  widenTicks: 20,
  dropActionIndexes: [0, 0],
  addReducing: [{ kind: "reduce", lane: "A", slot: 0, liquidity: "12345678901234567890" }],
  rationale: "halve it",
});

describe("overlay planner (LLM, off in M2)", () => {
  it("validates strictly and converts the wire format (bigint liquidity, deduped drops)", async () => {
    const llm = new FakeLlmClient([proposal]);
    const { proposal: p, raw } = await createOverlayPlanner(llm).propose(ctx());
    expect(p.addReducing).toEqual([
      { kind: "reduce", lane: "A", slot: 0, liquidity: 12345678901234567890n },
    ]);
    expect(p.dropActionIndexes).toEqual([0]);
    expect(raw).toBe(proposal);
    expect(llm.calls[0]?.user).toMatch(/VERIFIED FIGURES/);
    expect(llm.calls[0]?.user).not.toMatch(/0x[0-9a-fA-F]{40}/); // no addresses in prompts
  });

  it("retries bad output, then throws (the stage turns that into the identity overlay)", async () => {
    const bad = JSON.stringify({ ...JSON.parse(proposal), notionalScaleBps: 20_000 });
    const withAddress = JSON.stringify({
      ...JSON.parse(proposal),
      rationale: "use 0x9999999999999999999999999999999999999999",
    });
    const llm = new FakeLlmClient([bad, withAddress, "not json"]);
    await expect(createOverlayPlanner(llm).propose(ctx())).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    expect(llm.calls).toHaveLength(3);
  });

  it("a 402 propagates at once", async () => {
    const llm = new FakeLlmClient([new LlmCreditsExhausted()]);
    await expect(createOverlayPlanner(llm).propose(ctx())).rejects.toBeInstanceOf(
      LlmCreditsExhausted,
    );
    expect(llm.calls).toHaveLength(1);
  });

  it("proposalFromWire keeps non-reduce actions as they are", () => {
    expect(
      proposalFromWire({ ...IDENTITY_PROPOSAL, addReducing: [{ kind: "pause", lane: "A" }] })
        .addReducing,
    ).toEqual([{ kind: "pause", lane: "A" }]);
  });
});

describe("overlay critic (LLM, off in M2)", () => {
  it("returns the model's verdict", async () => {
    const llm = new FakeLlmClient([JSON.stringify({ verdict: "APPROVE", reason: "tighter" })]);
    const r = await createOverlayCritic(llm).critique(ctx(), IDENTITY_PROPOSAL);
    expect(r.verdict).toEqual({ verdict: "APPROVE", reason: "tighter" });
  });

  it("fails closed: invalid output or a transport error is a REJECT, never a throw", async () => {
    const invalid = await createOverlayCritic(
      new FakeLlmClient(["maybe", "maybe", "maybe"]),
    ).critique(ctx(), IDENTITY_PROPOSAL);
    expect(invalid.verdict.verdict).toBe("REJECT");
    expect(invalid.raw).toBe("maybe");
    const down = await createOverlayCritic(new FakeLlmClient([new Error("ECONNRESET")])).critique(
      ctx(),
      IDENTITY_PROPOSAL,
    );
    expect(down.verdict.verdict).toBe("REJECT");
  });

  it("a 402 propagates so the daemon can go deterministic", async () => {
    await expect(
      createOverlayCritic(new FakeLlmClient([new LlmCreditsExhausted()])).critique(
        ctx(),
        IDENTITY_PROPOSAL,
      ),
    ).rejects.toBeInstanceOf(LlmCreditsExhausted);
  });
});
