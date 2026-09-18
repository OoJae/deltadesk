// DeltaDesk tape recorder: captures the off-chain reference prices that cannot be backfilled later.
// On-chain data (swaps, mints, Chainlink rounds) is backfilled from logs by the indexer; this records
// what only exists in real time: Hyperliquid's 24/7 book/marks and Robinhood's reference bid/ask.
//
// Zero dependencies (Node >= 22: global WebSocket + fetch). Output: data/tape/<stream>/<UTC-hour>.jsonl
// Every line: {"t": <local receive ms>, ...payload}. Run: node recorder/tape.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tape');

const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const RH = 'https://api.robinhood.com/rhj';

// Hedge / reference markets on the trade.xyz HIP-3 dex (asset id = 110000 + index).
const HL_COINS = ['xyz:NVDA', 'xyz:SP500', 'xyz:XYZ100', 'xyz:TSLA', 'xyz:AAPL', 'xyz:META', 'xyz:GOOGL', 'xyz:HIMS', 'xyz:SPCX'];
// Robinhood Chain stock tokens: core lanes every 1s, the rest every 5s.
const RH_FAST = ['NVDA', 'SPY', 'QQQ'];
const RH_SLOW = ['TSLA', 'AAPL', 'META', 'GOOGL', 'HIMS', 'SPCX'];

// ---------- rotating JSONL writer ----------
const streams = new Map();
const counts = {};
function write(stream, obj) {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  let s = streams.get(stream);
  if (!s || s.hour !== hour) {
    if (s) s.fd.end();
    const dir = path.join(ROOT, stream);
    fs.mkdirSync(dir, { recursive: true });
    s = { hour, fd: fs.createWriteStream(path.join(dir, `${hour}.jsonl`), { flags: 'a' }) };
    streams.set(stream, s);
  }
  s.fd.write(JSON.stringify({ t: now.getTime(), ...obj }) + '\n');
  counts[stream] = (counts[stream] || 0) + 1;
}

function logErr(where, err) {
  write('errors', { where, err: String(err?.message || err) });
}

// ---------- Hyperliquid websocket (bbo, activeAssetCtx, trades) ----------
let ws = null;
let wsBackoff = 1000;
let lastWsMsg = 0;
function connectWs() {
  ws = new WebSocket(HL_WS);
  ws.onopen = () => {
    wsBackoff = 1000;
    write('meta', { event: 'hl_ws_open' });
    for (const coin of HL_COINS) {
      for (const type of ['bbo', 'activeAssetCtx', 'trades']) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type, coin } }));
      }
    }
  };
  ws.onmessage = (e) => {
    lastWsMsg = Date.now();
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const ch = m.channel;
    if (ch === 'bbo') write('hl_bbo', { coin: m.data.coin, ts: m.data.time, bid: m.data.bbo[0], ask: m.data.bbo[1] });
    else if (ch === 'activeAssetCtx') write('hl_ctx', { coin: m.data.coin, ...m.data.ctx });
    else if (ch === 'trades') for (const tr of m.data) write('hl_trades', { coin: tr.coin, ts: tr.time, side: tr.side, px: tr.px, sz: tr.sz, tid: tr.tid, hash: tr.hash });
  };
  ws.onclose = () => {
    write('meta', { event: 'hl_ws_close', backoff: wsBackoff });
    setTimeout(connectWs, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 60_000);
  };
  ws.onerror = (e) => logErr('hl_ws', e?.message || 'ws error');
}
// Keepalive + stale-connection watchdog.
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
  if (lastWsMsg && Date.now() - lastWsMsg > 90_000 && ws) { write('meta', { event: 'hl_ws_stale_reconnect' }); try { ws.close(); } catch {} lastWsMsg = 0; }
}, 30_000);

// ---------- Hyperliquid REST: full xyz universe snapshot (oracle, mark, impact, funding, OI) ----------
async function hlSnapshot() {
  try {
    const r = await fetch(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }), signal: AbortSignal.timeout(8000) });
    const [meta, ctxs] = await r.json();
    const rows = meta.universe.map((u, i) => ({ i, name: u.name, ...ctxs[i] }));
    write('hl_xyz_snapshot', { rows });
  } catch (e) { logErr('hl_snapshot', e); }
}

// ---------- Robinhood reference quotes ----------
async function rhQuote(sym) {
  try {
    const r = await fetch(`${RH}/prices/${sym}`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const q = j.quotes?.[0];
    if (!q) return logErr('rh_quote', `${sym}: ${JSON.stringify(j).slice(0, 200)}`);
    write('rh_quotes', { sym, bid: q.bid, ask: q.ask, halt: q.isTradingHalt, gen: q.generatedAt, vol: q.dailyTradingVolume, mbTok: q.mintBurnTokenVolume, mbUsd: q.mintBurnUsdVolume, hi: q.dailyHigh, lo: q.dailyLow });
  } catch (e) { logErr('rh_quote', `${sym}: ${e?.message || e}`); }
}

// Hourly: asset registry (multipliers, pending corporate actions) + corporate actions feed.
async function rhReference() {
  for (const [stream, url] of [['rh_assets', `${RH}/assets`], ['rh_corporate_actions', `${RH}/corporate-actions`]]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      write(stream, { body: await r.json() });
    } catch (e) { logErr(stream, e); }
  }
}

// ---------- schedule ----------
connectWs();
hlSnapshot(); setInterval(hlSnapshot, 5_000);
setInterval(() => RH_FAST.forEach(rhQuote), 1_000);
setInterval(() => RH_SLOW.forEach(rhQuote), 5_000);
rhReference(); setInterval(rhReference, 3_600_000);

setInterval(() => {
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${new Date().toISOString()} ${summary}`);
}, 60_000);

const shutdown = () => { write('meta', { event: 'shutdown' }); for (const s of streams.values()) s.fd.end(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
write('meta', { event: 'start', hlCoins: HL_COINS, rhFast: RH_FAST, rhSlow: RH_SLOW });
console.log(`tape recorder started → ${ROOT}`);
