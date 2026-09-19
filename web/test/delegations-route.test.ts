// GET /api/desk/delegations/:operator relays only its documented shape: the 4 fields of DelegationView on success,
// and { error } alone on any other status, whatever else desk-agent's response carries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const OP = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const AGENT = "http://desk-agent.test";

let upstream: Response;
const fetchMock = vi.fn<typeof fetch>(async () => upstream);

async function get(operator = OP) {
  const { GET } = await import("@/app/api/desk/delegations/[operator]/route");
  const req = new Request(`http://localhost/api/desk/delegations/${operator}`, { headers: { authorization: "Bearer a.b.c" } });
  const res = await GET(req, { params: Promise.resolve({ operator }) });
  return { status: res.status, body: (await res.json()) as unknown };
}

const reply = (body: unknown, status: number, statusText = "") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetModules(); // lib/desk/agent.ts reads AGENT_API_URL at import
  vi.stubEnv("AGENT_API_URL", AGENT);
  vi.stubEnv("AGENT_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/desk/delegations/:operator", () => {
  it("keeps only the documented fields of a success", async () => {
    upstream = reply({ operator: OP, status: "active", walletId: "w1", updatedAtMs: 1, userId: "u1", keyShareCiphertext: "secret" }, 200);
    const r = await get();
    expect(r).toEqual({ status: 200, body: { operator: OP, status: "active", walletId: "w1", updatedAtMs: 1 } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${AGENT}/delegations/${OP}`);
  });

  it("reduces an error to { error }, keeping the status", async () => {
    upstream = reply({ error: "wallet not in this sign-in", keyShareCiphertext: "secret", detail: { userId: "u1" } }, 403);
    expect(await get()).toEqual({ status: 403, body: { error: "wallet not in this sign-in" } });
  });

  it("an error without an error string becomes the status text", async () => {
    upstream = reply({ walletId: "w1", keyShareCiphertext: "secret" }, 502, "Bad Gateway");
    expect(await get()).toEqual({ status: 502, body: { error: "Bad Gateway" } });
  });

  it("a non-JSON error body is cut to 300 characters", async () => {
    upstream = reply(`<html>${"x".repeat(1000)}</html>`, 500, "Internal Server Error");
    const r = await get();
    expect(r.status).toBe(500);
    expect(Object.keys(r.body as object)).toEqual(["error"]);
    expect((r.body as { error: string }).error).toHaveLength(300);
  });

  it("refuses a malformed operator without calling desk-agent", async () => {
    expect(await get("0x1234")).toEqual({ status: 400, body: { error: "operator must be an address" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
