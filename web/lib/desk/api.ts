// Browser -> Next route handlers (/api/desk/*) -> desk-agent. The Dynamic JWT proves the caller is the Vault; the
// agent key is added server-side and never reaches this file.
import type { AgentResult } from "./types";

export async function deskApi<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; jwt?: string | null } = {}): Promise<AgentResult<T>> {
  try {
    const headers: Record<string, string> = {};
    if (init.jwt) headers.authorization = `Bearer ${init.jwt}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`/api/desk${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : res.statusText;
      return { ok: false, status: res.status, error: err };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "request failed" };
  }
}
