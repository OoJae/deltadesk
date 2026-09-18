// Server-side access to the DeltaDesk API. The premium key never reaches the browser.
import "server-only";

const API = process.env.DELTADESK_API ?? "http://127.0.0.1:8787";
const KEY = process.env.DELTADESK_API_KEY ?? "";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function api<T>(path: string, init?: { premium?: boolean }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: init?.premium ? { "x-deltadesk-key": KEY } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, error: body?.detail ?? res.statusText };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "request failed" };
  }
}

export type Row = Record<string, number | string | boolean | null>;
export const table = (scope: string, name: string, pool?: string) =>
  api<{ rows: Row[] }>(`/study/table/${scope}/${name}${pool ? `?pool=${encodeURIComponent(pool)}` : ""}`);
