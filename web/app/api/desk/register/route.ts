import { agentFetch, bad, laneParam, readJson } from "@/lib/desk/agent";
import { CHAIN_ID } from "@/lib/desk/chain";

// POST /desks: register a lane that exists on-chain. The agent checks the Vault JWT and the delegated operator.
export async function POST(req: Request) {
  const body = await readJson(req);
  const lane = typeof body?.lane === "string" ? laneParam(body.lane) : null;
  if (!lane) return bad("lane must be an address");
  if (body?.chainId !== CHAIN_ID) return bad(`chainId must be ${CHAIN_ID}`);
  return agentFetch(req, "/desks", { method: "POST", body: { lane, chainId: CHAIN_ID } });
}
