import { agentFetch, bad, laneParam } from "@/lib/desk/agent";

export async function GET(req: Request, ctx: { params: Promise<{ lane: string }> }) {
  const lane = laneParam((await ctx.params).lane);
  if (!lane) return bad("lane must be an address");
  return agentFetch(req, `/desks/${lane}/status`, { method: "GET" });
}
