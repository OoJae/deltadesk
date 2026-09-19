import { isHex } from "viem";
import { agentFetch, bad, laneParam, readJson } from "@/lib/desk/agent";

// Copilot approval from the web (alongside Telegram and the file gate). Silence means no, so declining is optional.
export async function POST(req: Request, ctx: { params: Promise<{ lane: string }> }) {
  const lane = laneParam((await ctx.params).lane);
  if (!lane) return bad("lane must be an address");
  const body = await readJson(req);
  const decisionId = body?.decisionId;
  if (typeof decisionId !== "string" || !isHex(decisionId) || decisionId.length !== 66) return bad("decisionId must be bytes32 hex");
  if (typeof body?.approve !== "boolean") return bad("approve must be a boolean");
  return agentFetch(req, `/desks/${lane}/approve`, { method: "POST", body: { decisionId, approve: body.approve } });
}
