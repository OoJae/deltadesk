import { agentFetch } from "@/lib/desk/agent";

// Plan B operator: DeltaDesk's Dynamic server wallet, used when the environment can't hold a second embedded wallet.
export async function GET(req: Request) {
  return agentFetch(req, "/operator-address", { method: "GET" });
}
