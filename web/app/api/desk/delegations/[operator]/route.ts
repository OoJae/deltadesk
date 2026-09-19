import { addressParam, agentFetch, bad } from "@/lib/desk/agent";

// GET /delegations/:operator: desk-agent's record of the Operator's Dynamic delegation (active | revoked | unknown),
// readable before the desk is registered. The agent checks that the JWT's verified wallets include the operator. Only
// the documented fields are relayed, whatever else the agent's response carries; an error response becomes { error }.
export async function GET(req: Request, ctx: { params: Promise<{ operator: string }> }) {
  const operator = addressParam((await ctx.params).operator);
  if (!operator) return bad("operator must be an address");
  return agentFetch(req, `/delegations/${operator}`, { method: "GET", pick: ["operator", "status", "walletId", "updatedAtMs"] });
}
