// DeltaDesk x402 handler: should you LP this tokenized-stock pool right now. Proxies to the DeltaDesk API with the premium key.
// Non-2xx upstream responses are passed through as errors, so the caller is not charged (settle-after-response).
const API = process.env.DELTADESK_API ?? "";
const KEY = process.env.DELTADESK_API_KEY ?? "";
const POOLS = new Set(["NVDA", "SPY", "TSLA", "QQQ-SPY"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const pool = (url.searchParams.get("pool") ?? "").toUpperCase();
  if (!POOLS.has(pool)) return json({ error: "pool must be one of NVDA, SPY, TSLA, QQQ-SPY" }, 400);
  const upstream = await fetch(`${API}/safe-to-lp/${pool}`, {
    headers: { "x-deltadesk-key": KEY },
    signal: AbortSignal.timeout(25_000),
  });
  if (!upstream.ok) return json({ error: `upstream ${upstream.status}`, detail: await upstream.text() }, upstream.status >= 500 ? 502 : upstream.status);
  return json(await upstream.json());
}
