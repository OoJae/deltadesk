import { getLaneActions } from "@/lib/console/chain";

export const dynamic = "force-dynamic";

// On-chain LaneAction events of the registered lanes since the lane factory's deployment on 4663, read-only, memoised 15 s.
export async function GET() {
  const result = await getLaneActions();
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
