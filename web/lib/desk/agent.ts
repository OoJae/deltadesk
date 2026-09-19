// Server-side proxy to desk-agent. The agent key never reaches the browser; the user's Dynamic JWT is forwarded as-is
// so the agent can check that the verified wallet is the lane's owner (the Vault).
//   AGENT_API_URL  base URL of desk-agent (e.g. https://desk-agent.up.railway.app)
//   AGENT_API_KEY  shared secret the agent expects from this web service
import "server-only";
import { getAddress, isAddress, type Address } from "viem";

const AGENT = (process.env.AGENT_API_URL ?? "").trim().replace(/\/+$/, "");
const KEY = process.env.AGENT_API_KEY ?? "";

/** Header carrying AGENT_API_KEY. Must match desk-agent's http/auth.ts. */
export const AGENT_KEY_HEADER = "x-desk-agent-key";
const MAX_BODY_BYTES = 16 * 1024;
const JWT_RE = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export const bad = (error: string, status = 400) => json({ error }, status);

/** Canonical lane address from a route param, or null when it is not an address (never interpolate raw input). */
export const laneParam = (raw: string): Address | null => (isAddress(raw) ? getAddress(raw) : null);

/** Like laneParam but case-insensitive (a lowercase or uppercase hex address is fine; the result is checksummed). */
export const addressParam = (raw: string): Address | null => (isAddress(raw, { strict: false }) ? getAddress(raw) : null);

/** Reads a small JSON body; null on oversize or invalid JSON. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return null;
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY_BYTES) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Forwards to desk-agent and relays its JSON and status. `path` must be built from validated values only. `pick` is for
 * routes whose contract is a fixed shape: a successful response keeps only those top-level fields, and any other
 * response is reduced to `{ error }` (a string, at most 300 characters), whatever else desk-agent sent.
 */
export async function agentFetch(req: Request, path: string, init: { method: "GET" | "POST"; body?: unknown; pick?: readonly string[] }): Promise<Response> {
  if (!AGENT) return bad("desk-agent is not configured (AGENT_API_URL is unset)", 503);
  const headers: Record<string, string> = { accept: "application/json" };
  if (KEY) headers[AGENT_KEY_HEADER] = KEY;
  const auth = req.headers.get("authorization");
  if (auth && auth.length < 8192 && JWT_RE.test(auth)) headers.authorization = auth;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${AGENT}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 300) || res.statusText };
    }
    if (init.pick) {
      const src = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      body = res.ok
        ? Object.fromEntries(init.pick.filter((k) => k in src).map((k) => [k, src[k]]))
        : { error: (typeof src.error === "string" && src.error ? src.error : res.statusText || `HTTP ${res.status}`).slice(0, 300) };
    } else if (!res.ok && (typeof body !== "object" || body === null || !("error" in body))) body = { error: res.statusText, detail: body };
    return json(body, res.status);
  } catch (e) {
    return bad(`desk-agent unreachable: ${e instanceof Error ? e.message : "request failed"}`, 502);
  }
}
