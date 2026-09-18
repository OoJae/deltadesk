import { api } from "@/lib/api";
import { POOLS, poolParam } from "@/lib/format";

export const dynamic = "force-dynamic";

// One round-trip for the Live desk: fair value + safe-to-lp for every pool (premium key stays server-side).
export async function GET() {
  const results = await Promise.all(
    POOLS.map(async (key) => {
      const p = poolParam(key);
      const [fv, safe] = await Promise.all([api<Record<string, unknown>>(`/fair-value/${p}`), api<Record<string, unknown>>(`/safe-to-lp/${p}`, { premium: true })]);
      return { pool: key, fair: fv.ok ? fv.data : null, safe: safe.ok ? safe.data : null, error: !fv.ok ? fv.error : !safe.ok ? safe.error : null };
    }),
  );
  return Response.json({ at: Date.now(), pools: results }, { headers: { "cache-control": "no-store" } });
}
