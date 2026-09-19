import { getPublicFeed } from "@/lib/console/feed";

export const dynamic = "force-dynamic";

// The console's live-desk poll: desk-agent's public feed, re-picked and memoised server-side (lib/console/feed.ts).
export async function GET() {
  const result = await getPublicFeed();
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
