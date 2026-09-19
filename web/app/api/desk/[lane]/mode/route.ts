import { isHex } from "viem";
import { agentFetch, bad, laneParam, readJson } from "@/lib/desk/agent";
import { MODES } from "@/lib/desk/types";

// Mode changes carry the Vault's EIP-191 signature over `DeltaDesk mode <lane> <mode> <nonce>`; the agent verifies it.
export async function POST(req: Request, ctx: { params: Promise<{ lane: string }> }) {
  const lane = laneParam((await ctx.params).lane);
  if (!lane) return bad("lane must be an address");
  const body = await readJson(req);
  const mode = MODES.find((m) => m.enabled && m.mode === body?.mode)?.mode;
  if (!mode) return bad("unknown or unavailable mode");
  const signature = body?.signature;
  if (typeof signature !== "string" || !isHex(signature) || signature.length > 1000) return bad("signature must be hex");
  const nonce = body?.nonce;
  if (typeof nonce !== "string" || !/^\d{1,20}$/.test(nonce)) return bad("nonce must be a decimal string");
  const message = `DeltaDesk mode ${lane} ${mode} ${nonce}`;
  return agentFetch(req, `/desks/${lane}/mode`, { method: "POST", body: { mode, signature, nonce, message } });
}
