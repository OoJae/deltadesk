// DeltaDesk x402 handler: LP P&L tearsheet for a wallet. Proxies to the DeltaDesk API with the premium key.
// Non-2xx upstream responses are passed through as errors, so the caller is not charged (settle-after-response).
const API = process.env.DELTADESK_API ?? "";
const KEY = process.env.DELTADESK_API_KEY ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase();
  const chain = (url.searchParams.get("chain") ?? "robinhood").toLowerCase();
  const role = (url.searchParams.get("role") ?? "auto").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return json({ error: "wallet must be a 0x address" }, 400);
  if (chain !== "robinhood" && chain !== "base") return json({ error: "chain must be robinhood or base" }, 400);
  if (!["auto", "owner", "operator"].includes(role)) return json({ error: "role must be auto, owner or operator" }, 400);
  const upstream = await fetch(`${API}/tearsheet/${chain}/${wallet}?role=${role}`, {
    headers: { "x-deltadesk-key": KEY },
    signal: AbortSignal.timeout(25_000),
  });
  if (!upstream.ok) return json({ error: `upstream ${upstream.status}`, detail: await upstream.text() }, upstream.status >= 500 ? 502 : upstream.status);
  return json(await upstream.json());
}
