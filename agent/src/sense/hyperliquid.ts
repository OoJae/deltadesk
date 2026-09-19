/**
 * Hyperliquid reference feed for xyz:NVDA (the trade.xyz HIP-3 dex).
 *
 * WebSocket subscriptions exactly as recorder/tape.mjs: {"method":"subscribe","subscription":
 * {"type": "bbo" | "activeAssetCtx" | "trades", "coin": "xyz:NVDA"}}. bbo gives the touch (the mid
 * feeds F), activeAssetCtx the mark and oracle prices, trades the tape for paper fills.
 * When the ws quote is older than wsStaleMs, a poller asks REST {"type":"allMids","dex":"xyz"} and
 * latest() serves that mid instead. Keepalive ping every 30 s; a socket silent for 90 s is
 * recycled; reconnects back off 1 s → 60 s. Nothing here throws into the tick loop.
 */

import type { Clock, DeskLogger, Hex, HlFeed, HlQuote, HlTrade, SourceStatus } from "../types.js";
import { HL_NVDA_COIN } from "../types.js";

export type { HlAssetCtx, HlBbo, HlFeed, HlQuote, HlTrade } from "../types.js";

/** The subset of the WHATWG WebSocket the feed uses (Node ≥ 22 has a global WebSocket). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface HlFeedOptions {
  wsUrl: string;
  infoUrl: string;
  clock: Clock;
  coin?: string;
  dex?: string;
  wsFactory?: WebSocketFactory;
  fetchImpl?: typeof fetch;
  /** Override the REST fallback (e.g. hl/client.ts HlInfoClient.allMids). */
  allMids?: (dex: string) => Promise<Record<string, string>>;
  timers?: Timers;
  logger?: DeskLogger;
  wsStaleMs?: number;
  restPollMs?: number;
  pingMs?: number;
  silentReconnectMs?: number;
  restTimeoutMs?: number;
}

const OPEN = 1;

function num(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function createHlFeed(opts: HlFeedOptions): HlFeed {
  const coin = opts.coin ?? HL_NVDA_COIN;
  const dex = opts.dex ?? "xyz";
  const timers = opts.timers ?? realTimers;
  const wsStaleMs = opts.wsStaleMs ?? 5_000;
  const restPollMs = opts.restPollMs ?? 2_000;
  const pingMs = opts.pingMs ?? 30_000;
  const silentMs = opts.silentReconnectMs ?? 90_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wsFactory: WebSocketFactory =
    opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  const allMids =
    opts.allMids ??
    (async (d: string): Promise<Record<string, string>> => {
      const res = await fetchImpl(opts.infoUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "allMids", dex: d }),
        signal: AbortSignal.timeout(opts.restTimeoutMs ?? 5_000),
      });
      if (!res.ok) throw new Error(`HL allMids answered ${res.status}`);
      return (await res.json()) as Record<string, string>;
    });

  let ws: WebSocketLike | null = null;
  let running = false;
  let backoffMs = 1_000;
  let lastWsMessageMs = 0;
  let wsQuote: HlQuote | null = null;
  let restQuote: HlQuote | null = null;
  let restOk = false;
  let restInFlight = false;
  let lastError: string | null = null;
  let ctx: { markPx: number | null; oraclePx: number | null } = { markPx: null, oraclePx: null };
  const listeners = new Set<(t: HlTrade) => void>();
  const handles: unknown[] = [];
  let reconnectHandle: unknown = null;

  const wsFresh = (now: number): boolean =>
    wsQuote !== null && now - wsQuote.receivedAtMs <= wsStaleMs;

  function onMessage(raw: unknown): void {
    lastWsMessageMs = opts.clock.now();
    let m: { channel?: string; data?: unknown };
    try {
      m = JSON.parse(typeof raw === "string" ? raw : String(raw)) as typeof m;
    } catch {
      return;
    }
    const data = m.data as Record<string, unknown> | unknown[] | undefined;
    if (m.channel === "bbo" && data !== undefined && !Array.isArray(data) && data.coin === coin) {
      const [b, a] = (data.bbo as Array<{ px: string } | null>) ?? [null, null];
      const bid = num(b?.px);
      const ask = num(a?.px);
      if (bid === null || ask === null || !(bid > 0) || ask < bid) return; // one-sided or crossed
      wsQuote = {
        coin,
        bid,
        ask,
        mid: (bid + ask) / 2,
        markPx: ctx.markPx,
        oraclePx: ctx.oraclePx,
        exchangeTimeMs: num(data.time),
        receivedAtMs: lastWsMessageMs,
        source: "ws",
      };
    } else if (
      m.channel === "activeAssetCtx" &&
      data !== undefined &&
      !Array.isArray(data) &&
      data.coin === coin
    ) {
      const c = data.ctx as Record<string, unknown> | undefined;
      ctx = { markPx: num(c?.markPx), oraclePx: num(c?.oraclePx) };
      if (wsQuote !== null) wsQuote = { ...wsQuote, markPx: ctx.markPx, oraclePx: ctx.oraclePx };
    } else if (m.channel === "trades" && Array.isArray(data)) {
      for (const t of data as Array<Record<string, unknown>>) {
        if (t.coin !== coin) continue;
        const trade: HlTrade = {
          coin,
          side: t.side === "B" ? "B" : "A",
          px: String(t.px),
          sz: String(t.sz),
          time: num(t.time) ?? 0,
          hash: String(t.hash) as Hex,
          tid: num(t.tid) ?? 0,
        };
        for (const l of listeners) {
          try {
            l(trade);
          } catch (err) {
            opts.logger?.warn({ err }, "HL trade listener threw");
          }
        }
      }
    } else if (m.channel === "error") {
      lastError = `HL ws error: ${JSON.stringify(m.data)}`;
      opts.logger?.warn({ data: m.data }, "HL ws error message");
    }
  }

  function connect(): void {
    if (!running) return;
    let sock: WebSocketLike;
    try {
      sock = wsFactory(opts.wsUrl);
    } catch (err) {
      lastError = `HL ws connect failed: ${err instanceof Error ? err.message : String(err)}`;
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      backoffMs = 1_000;
      lastWsMessageMs = opts.clock.now();
      for (const type of ["bbo", "activeAssetCtx", "trades"]) {
        sock.send(JSON.stringify({ method: "subscribe", subscription: { type, coin } }));
      }
    };
    sock.onmessage = (ev) => onMessage(ev.data);
    sock.onerror = () => {
      lastError = "HL ws error";
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (!running || reconnectHandle !== null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    reconnectHandle = timers.setTimeout(() => {
      reconnectHandle = null;
      connect();
    }, delay);
  }

  async function pollRest(): Promise<void> {
    const now = opts.clock.now();
    if (wsFresh(now) || restInFlight) return;
    restInFlight = true;
    try {
      const mids = await allMids(dex);
      const bare = coin.includes(":") ? coin.slice(coin.indexOf(":") + 1) : coin;
      const mid = num(mids[coin] ?? mids[bare]);
      if (mid === null || !(mid > 0)) throw new Error(`allMids has no ${coin}`);
      const at = opts.clock.now();
      restQuote = {
        coin,
        bid: mid,
        ask: mid,
        mid,
        markPx: null,
        oraclePx: null,
        exchangeTimeMs: null,
        receivedAtMs: at,
        source: "rest",
      };
      restOk = true;
    } catch (err) {
      restOk = false;
      lastError = `HL REST fallback failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      restInFlight = false;
    }
  }

  function latest(): HlQuote | null {
    const now = opts.clock.now();
    if (wsFresh(now)) return wsQuote;
    if (wsQuote === null) return restQuote;
    if (restQuote === null) return wsQuote;
    return restQuote.receivedAtMs > wsQuote.receivedAtMs ? restQuote : wsQuote;
  }

  return {
    start() {
      if (running) return;
      running = true;
      connect();
      handles.push(
        timers.setInterval(() => {
          void pollRest();
        }, restPollMs),
        timers.setInterval(() => {
          if (ws?.readyState === OPEN) {
            try {
              ws.send(JSON.stringify({ method: "ping" }));
            } catch {
              /* the close handler reconnects */
            }
          }
          if (ws !== null && lastWsMessageMs > 0 && opts.clock.now() - lastWsMessageMs > silentMs) {
            lastError = "HL ws silent: recycling the connection";
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          }
        }, pingMs),
      );
      void pollRest();
    },
    async stop() {
      running = false;
      for (const h of handles.splice(0)) timers.clearInterval(h);
      if (reconnectHandle !== null) {
        timers.clearTimeout(reconnectHandle);
        reconnectHandle = null;
      }
      const s = ws;
      ws = null;
      try {
        s?.close();
      } catch {
        /* ignore */
      }
    },
    latest,
    status(nowMs: number): SourceStatus {
      const q = latest();
      if (q === null) return { ok: false, ageMs: null, reason: lastError ?? "no HL quote yet" };
      const ageMs = nowMs - q.receivedAtMs;
      if (q.source === "ws")
        return { ok: wsFresh(nowMs) || restOk, ageMs, reason: wsFresh(nowMs) ? null : lastError };
      return { ok: restOk, ageMs, reason: restOk ? "REST allMids fallback (ws stale)" : lastError };
    },
    onTrade(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
