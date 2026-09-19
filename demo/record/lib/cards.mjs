// HTML cards for the demo, designed at 1280x720 CSS px (recorded or screenshotted at deviceScaleFactor 1.5 → 1920x1080).
// Tokens match web/app/globals.css (light theme), fonts match the web app (Geist, Geist Mono).

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const BASE_CSS = `
:root {
  --page: #f9f9f7; --surface-1: #fcfcfb; --surface-2: #f3f2ee; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --ring: rgba(11,11,11,0.1); --accent: #2a78d6; --orange: #eb6834; --green: #1baf7a;
  --neg: #d03b3b; --warn: #fab219; --pos-2: #86b6ef; --neg-2: #f09c9b;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { width: 100%; height: 100%; overflow: hidden; background: var(--page); }
body { width: 1280px; height: 720px; overflow: hidden; position: relative; }
body { background: var(--page); color: var(--ink); font-family: "Geist", system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
.mono { font-family: "Geist Mono", ui-monospace, Menlo, monospace; }
.wrap { position: absolute; inset: 0; padding: 64px 96px 96px; display: flex; flex-direction: column; }
.eyebrow { font-size: 14px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
.card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 18px; }
.logo { display: inline-flex; align-items: center; gap: 14px; font-weight: 600; }
.logo svg { width: 44px; height: 44px; }
.src { font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.fade { opacity: 0; animation: fadeUp .7s ease forwards; }
body:not(.go) .fade { animation-play-state: paused; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.neg { color: var(--neg); } .pos { color: #0a7f4f; }
`;

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#eef4fc"/><path d="M6 21l6-6 5 4 9-10" fill="none" stroke="#2a78d6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function page(body, { css = "", title = "DeltaDesk demo" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=block" rel="stylesheet">
<style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

// delay(s) → inline animation-delay style
const d = (s) => `animation-delay:${s.toFixed(2)}s;`;

export function titleCard() {
  return page(
    `<div class="wrap" style="justify-content:center;align-items:flex-start;padding-left:140px">
      <div class="logo fade" style="font-size:64px;gap:22px">${LOGO.replace('aria-hidden="true"', 'aria-hidden="true" style="width:84px;height:84px"')}DeltaDesk</div>
      <div class="fade" style="${d(0.35)}font-size:34px;color:var(--ink-2);margin-top:26px;max-width:900px;line-height:1.3">The open market-making desk for tokenized stocks</div>
      <div class="fade eyebrow" style="${d(0.8)}margin-top:44px">Runtime Agent Week · Bankr × Propaganda · Robinhood Chain · Base</div>
    </div>`,
  );
}

export function quoteCard(duration) {
  const second = Math.max(2, duration * 0.62);
  return page(
    `<div class="wrap" style="justify-content:center;gap:40px;padding:0 120px">
      <figure class="fade">
        <blockquote style="font-size:44px;line-height:1.22;font-weight:600;letter-spacing:-.01em;max-width:1000px">
          “If I made <span style="color:var(--accent)">$80 in fees</span> but lost <span class="neg">$50 to informed flow</span>, that would be good to know.”</blockquote>
        <figcaption style="margin-top:16px;font-size:20px;color:var(--ink-2)">Igor, Bankr · LPs tokenized stocks</figcaption>
      </figure>
      <figure class="fade" style="${d(second)}border-left:4px solid var(--accent);padding-left:24px">
        <div style="font-size:32px;line-height:1.25;font-weight:500;max-width:1000px">Hayden Adams (Uniswap): can automated strategies perform well enough for AMMs to take on equities market making?</div>
        <figcaption style="margin-top:12px;font-size:18px;color:var(--ink-2)">paraphrased, not a verbatim quote</figcaption>
      </figure>
    </div>`,
  );
}

export function pendingCard(beat, cfg) {
  const missing = beat.missing ?? beat.requires ?? [];
  return page(
    `<div class="wrap" style="justify-content:center">
      <div style="display:flex;align-items:center;gap:14px">
        <span style="background:#6b6a66;color:#fff;font-weight:700;font-size:15px;letter-spacing:.14em;padding:7px 14px;border-radius:8px">PENDING</span>
        <span class="eyebrow">Beat ${esc(beat.num)} · not recorded yet · draft placeholder, not evidence</span>
      </div>
      <h1 style="font-size:52px;line-height:1.1;margin-top:26px;font-weight:600;letter-spacing:-.01em;max-width:1050px">${esc(beat.title)}</h1>
      <p style="font-size:22px;color:var(--ink-2);margin-top:22px;max-width:1050px;line-height:1.4">${esc(beat.surface.replace(/`/g, ""))}</p>
      <div class="card" style="margin-top:34px;padding:20px 24px;max-width:1050px">
        <div class="eyebrow" style="margin-bottom:10px">Fill in demo/record/config.json, then re-record this scene</div>
        <div class="mono" style="font-size:20px;line-height:1.6">${missing.map((k) => `{{${esc(k)}}}`).join("<br>")}</div>
      </div>
    </div>`,
  );
}

export function missingCard(beat) {
  return pendingCard({ ...beat, title: `${beat.title} (no recording yet)`, missing: [`run: node demo/record/run.mjs --scenes ${beat.slug}`] });
}

// Terminal-style panel. lines: [{t, cls?}] or strings; `hl` regex highlights matching lines.
export function terminal(lines, { title = "", hl = null } = {}) {
  const body = lines
    .map((l) => (typeof l === "string" ? { t: l } : l))
    .map((l) => `<div class="${l.cls ?? ""} ${hl && hl.test(l.t) ? "hl" : ""}">${esc(l.t) || "&nbsp;"}</div>`)
    .join("");
  return `<div class="term card"><div class="term-bar"><i></i><i></i><i></i><span>${esc(title)}</span></div><div class="term-body mono">${body}</div></div>`;
}

export const TERM_CSS = `
.term { overflow: hidden; background: #111214; border-color: #111214; color: #d8d6cf; }
.term-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #1c1d20; }
.term-bar i { width: 11px; height: 11px; border-radius: 50%; background: #3a3b3f; display: block; }
.term-bar span { margin-left: 10px; font-size: 13px; color: #8f8d86; font-family: "Geist Mono", monospace; }
.term-body { padding: 12px 16px; font-size: 12.5px; line-height: 1.42; white-space: pre-wrap; word-break: break-word; }
.term-body .dim { color: #8f8d86; } .term-body .ok { color: #58d39a; } .term-body .cmd { color: #9cc4f5; }
.term-body .hl { background: rgba(88,211,154,.14); box-shadow: inset 3px 0 0 #58d39a; }
`;

export function invariantsCard({ i1, local, fork }) {
  return page(
    `<div class="wrap" style="padding:52px 80px 110px;gap:18px">
      <div class="fade"><div class="eyebrow">Contracts · Foundry invariant campaigns · 2026-09-19</div>
        <h1 style="font-size:38px;font-weight:600;margin-top:8px;letter-spacing:-.01em">The lane can only pay its owner</h1>
        <p style="font-size:17px;color:var(--ink-2);margin-top:8px;max-width:1100px;line-height:1.4"><b style="color:var(--ink)">I1.</b> ${esc(i1)}</p></div>
      <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:18px;flex:1;min-height:0">
        <div class="fade" style="${d(0.6)}">${terminal(local.lines, { title: local.file, hl: /violations|runs logged|invariant_I1_/ })}</div>
        <div class="fade" style="${d(1.4)}">${terminal(fork.lines, { title: fork.file, hl: /violations|runs logged|ForkFiftyReranges/ })}</div>
      </div>
    </div>`,
    { css: TERM_CSS + ".term{height:100%}" },
  );
}

const money = (v, dp = 0) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const kusd = (v) => `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(1)}k`;

// rows: [{weekend, fee, picked, edge}] (NVDA/USDG, weekend dark window, HL 1h)
export function weekendCard({ rows, focus, source, line }) {
  const max = Math.max(...rows.flatMap((r) => [r.fee, r.picked]));
  const H = 240, bw = 26, gap = 8, group = bw * 2 + gap + 24;
  const W = rows.length * group;
  const f = rows.find((r) => r.weekend === focus);
  const bars = rows
    .map((r, i) => {
      const x = i * group;
      const hf = (r.fee / max) * H, hp = (Math.max(r.picked, 0) / max) * H;
      const on = r.weekend === focus;
      const [, mo, da] = r.weekend.split("-");
      return `<g opacity="${on ? 1 : 0.45}">
        <rect x="${x}" y="${H - hf}" width="${bw}" height="${hf}" rx="3" fill="#2a78d6"/>
        <rect x="${x + bw + 3}" y="${H - hp}" width="${bw}" height="${hp}" rx="3" fill="#eb6834"/>
        <text x="${x + bw + 2}" y="${H + 22}" text-anchor="middle" font-size="13" fill="${on ? "#0b0b0b" : "#898781"}" font-weight="${on ? 700 : 400}">${Number(mo)}/${Number(da)}</text>
        ${on ? `<rect x="${x - 7}" y="-8" width="${bw * 2 + 17}" height="${H + 40}" rx="8" fill="none" stroke="#0b0b0b" stroke-width="1.5" stroke-dasharray="4 4"/>` : ""}
      </g>`;
    })
    .join("");
  return page(
    `<div class="wrap" style="padding:56px 88px 110px">
      <div class="fade"><div class="eyebrow">Replay · NVDA/USDG · weekend dark window · markouts vs Hyperliquid, 1h</div>
      <h1 style="font-size:38px;font-weight:600;margin-top:10px;letter-spacing:-.01em;max-width:860px;line-height:1.15">Weekend of Sep 12–13: LPs earned ${kusd(f.fee)} in fees; informed flow took ${kusd(f.picked)} back</h1></div>
      <div style="display:flex;gap:40px;margin-top:22px;align-items:flex-end">
        <svg class="fade" style="animation-delay:.5s;overflow:visible" width="${W}" height="${H + 30}" viewBox="0 0 ${W} ${H + 30}">${bars}</svg>
        <div class="fade" style="animation-delay:1s;display:flex;flex-direction:column;gap:14px;width:270px">
          <div><span style="display:inline-block;width:12px;height:12px;background:#2a78d6;border-radius:2px"></span> <span style="font-size:15px;color:var(--ink-2)">LP fees</span>
          &nbsp; <span style="display:inline-block;width:12px;height:12px;background:#eb6834;border-radius:2px"></span> <span style="font-size:15px;color:var(--ink-2)">picked off</span></div>
          <div class="card" style="padding:16px 18px"><div class="eyebrow">Edge, Sep 12–13</div><div style="font-size:44px;font-weight:600">${f.edge.toFixed(2)}</div>
          <div style="font-size:14px;color:var(--ink-2)">lowest of the ${rows.length} weekends shown (fees ÷ picked off)</div></div>
        </div>
      </div>
      ${line ? `<div class="card fade" style="animation-delay:1.6s;margin-top:22px;padding:16px 20px;font-size:21px;font-weight:500">${esc(line)}</div>` : ""}
      <p class="src" style="margin-top:auto">Source: ${esc(source)} · fetched live at recording time. Weekend = the dark window between Friday's close and Sunday's reopen. Informational analytics, not investment advice.</p>
    </div>`,
  );
}

// r0 / r3: {fees_kept, picked_hl_1h_kept, net_kept, n_absent, n_swaps}
export function reopenCard({ date, r0, r3, source }) {
  const col = (label, sub, r, accent) => `
    <div class="card fade" style="padding:26px 28px;flex:1;${accent ? "outline:2px solid var(--accent)" : ""}">
      <div class="eyebrow">${esc(label)}</div>
      <div style="font-size:15px;color:var(--ink-2);margin-top:4px">${esc(sub)}</div>
      <div class="${r.net_kept < 0 ? "neg" : "pos"}" style="font-size:64px;font-weight:600;margin-top:14px;letter-spacing:-.02em">${money(r.net_kept)}</div>
      <div style="font-size:15px;color:var(--ink-2)">LP net for the day (fees − picked off, vs HL 1h)</div>
      <table style="margin-top:16px;font-size:16px;width:100%;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:var(--ink-2)">Fees kept</td><td style="text-align:right">${money(r.fees_kept)}</td></tr>
        <tr style="border-top:1px solid var(--grid)"><td style="padding:5px 0;color:var(--ink-2)">Picked off by informed flow</td><td style="text-align:right">${money(-r.picked_hl_1h_kept)}</td></tr>
        <tr style="border-top:1px solid var(--grid)"><td style="padding:5px 0;color:var(--ink-2)">Swaps sat out</td><td style="text-align:right">${r.n_absent.toLocaleString()} of ${r.n_swaps.toLocaleString()}</td></tr>
      </table>
    </div>`;
  return page(
    `<div class="wrap" style="padding:52px 88px 110px">
      <div class="fade"><div class="eyebrow">Replay · NVDA/USDG · pool-level backtest · ${esc(date)} (the reopen after Labor Day)</div>
      <h1 style="font-size:38px;font-weight:600;margin-top:10px;letter-spacing:-.01em;max-width:900px">REOPEN-GUARD: step out 09:20–09:45 ET</h1></div>
      <div style="display:flex;gap:24px;margin-top:26px">
        ${col("Always in (R0)", "a control LP that never leaves", r0, false)}
        ${col("Reopen guard (R3)", "out 09:20–09:45 weekdays and 19:50–20:15 Sunday", r3, true)}
      </div>
      <p class="src" style="margin-top:auto">Source: ${esc(source)} · fetched live at recording time. Counterfactual assumes an LP's absence doesn't change prices or flow. One day; the reopen guard was the only rule positive both in-sample (Jul 28–Aug 31) and out of sample (Sep 1–18), and no rule is statistically proven yet (docs/m1-truth-study.md §4).</p>
    </div>`,
  );
}

export function economicsCard() {
  const cell = (k, v, s) => `<div class="card" style="padding:18px 20px"><div style="font-size:14px;color:var(--ink-2)">${k}</div><div style="font-size:36px;font-weight:600;margin-top:4px">${v}</div><div style="font-size:13px;color:var(--muted);margin-top:2px">${s}</div></div>`;
  // One cost basis throughout: the 2x hurdle as built (agent/README.md "Economics at M2 size"). Every lane size here is
  // where a typical rerange clears that hurdle, not a break-even.
  return page(
    `<div class="wrap" style="padding:54px 88px 110px">
      <div class="fade"><div class="eyebrow">Honest economics · measured on Robinhood Chain, 2026-09-19</div>
      <h1 style="font-size:40px;font-weight:600;margin-top:10px;letter-spacing:-.01em">Small lanes hold wide ranges. A rerange clears our cost hurdle only at size.</h1></div>
      <div class="fade" style="animation-delay:.5s;display:grid;grid-template-columns:1.1fr 1fr 1fr 1fr;gap:16px;margin-top:28px">
        ${cell("One rerange (unwind + mint), measured", "≈ $0.107", "653,487 gas × 0.0618 gwei × $2,639.89 ETH")}
        ${cell("Fees a rerange must promise", "≥ $0.78", "2× the hurdle's cost: 1.2M gas × 2× base fee ≈ $0.392")}
        ${cell("Lane size to clear it, median hour", "≈ $36.7k", "typical rerange, hurdle as built (mean hour ≈ $26.6k)")}
        ${cell("Lane size to clear it, best hour", "≈ $4.3k", "typical rerange, hurdle as built (Thu 09:00 ET)")}
      </div>
      <div class="card fade" style="animation-delay:1.1s;margin-top:22px;padding:18px 22px;font-size:19px;line-height:1.45;max-width:1100px">
        A ~$50 lane: the hurdle-waived first placement executes, and no later rerange clears the 2× hurdle at any hour of the week. It holds its range until an exit.
      </div>
      <p class="src" style="margin-top:auto">Source: agent/README.md "Economics at M2 size" (gas from a fork rerange at block 67,115,529; base fee at block 67,112,851; ETH/USD from Chainlink on 4663; fees per $ from the engine's 168-hour NVDA/USDG record). If the hurdle priced the measured gas at the base fee instead: ≈ $10k at the median hour, ≈ $1.18k at the best.</p>
    </div>`,
  );
}

export function mondayCard() {
  return page(
    `<div class="wrap" style="justify-content:center;padding-left:120px">
      <div class="eyebrow fade">Coming Monday · posted as an update</div>
      <h1 class="fade" style="${d(0.2)}font-size:56px;font-weight:600;margin-top:16px;letter-spacing:-.015em;line-height:1.1;max-width:1000px">Mon Sep 21, regular session: the first live delegated mint</h1>
      <p class="fade" style="${d(0.6)}font-size:22px;color:var(--ink-2);margin-top:22px;max-width:980px;line-height:1.4">About $50, copilot-approved, with a matched LaneAction and its reasonHash preimage. Then the owner's exit and withdraw from the Vault.</p>
    </div>`,
  );
}

export function endCard(cfg) {
  const gh = cfg.placeholders?.GITHUB_URL?.trim();
  const links = [
    ["Web", cfg.webUrl.replace(/^https?:\/\//, "")],
    ["x402 (Bankr)", cfg.x402Base.replace(/^https?:\/\//, "") + "/…"],
    ...(gh ? [["Code", gh.replace(/^https?:\/\//, "")]] : []),
  ];
  return page(
    `<div class="wrap" style="justify-content:center;padding-left:120px">
      <h1 class="fade" style="font-size:54px;font-weight:600;letter-spacing:-.015em;line-height:1.15;max-width:1050px">Market making stocks was a closed club.<br><span style="color:var(--accent)">We published its books.</span></h1>
      <div class="fade" style="${d(0.9)}margin-top:40px;display:flex;flex-direction:column;gap:10px">
        <div class="logo" style="font-size:26px">${LOGO}DeltaDesk</div>
        ${links.map(([k, v]) => `<div style="font-size:18px"><span style="color:var(--muted);display:inline-block;width:130px">${esc(k)}</span><span class="mono">${esc(v)}</span></div>`).join("")}
      </div>
      <p class="src fade" style="${d(1.4)}position:absolute;bottom:40px;left:120px">Informational analytics, not investment advice.</p>
    </div>`,
  );
}

// Beat 08: the LaneAction log of the delegated signal() tx, decoded from its receipt (record/lib/chain.mjs).
export function signalCard({ ev, roles, check, hash }) {
  const sh = (a) => `${a.slice(0, 10)}…${a.slice(-6)}`;
  const isOp = ev.caller.toLowerCase() === roles.operator.toLowerCase();
  const row = (cls, k, raw, v) => `<tr class="${cls}"><td class="k">${esc(k)}</td><td class="raw mono">${esc(raw)}</td><td class="v">${v}</td></tr>`;
  const ok = check?.match === true;
  return page(
    `<div class="wrap" style="padding:44px 80px 100px;gap:14px">
      <div class="fade"><div class="eyebrow">Robinhood Chain · tx ${esc(sh(hash))} · block ${ev.block.toLocaleString("en-US")} · ${ev.status === 1 ? "success" : "failed"} · ${ev.gasUsed.toLocaleString("en-US")} gas</div>
        <h1 style="font-size:30px;font-weight:600;margin-top:8px;letter-spacing:-.01em;line-height:1.15">LaneAction, decoded: ${esc(ev.actionName)} · ${esc(ev.regimeName)} · ${esc(ev.gateNames.join(" + ") || "no gates").replace(/-/g, "\u2011")}</h1></div>
      <table class="card fade" style="${d(0.3)}border-collapse:separate;padding:10px 20px;font-size:17px;display:block">
        ${row("", "event", `topic0 ${sh(ev.topics[0])}`, "LaneAction (IDeskLane)")}
        ${row("row-action", "action (indexed)", String(ev.action), `<b>${esc(ev.actionName)}</b>: an event-only record of a gate change`)}
        ${row("", "decisionId (indexed)", sh(ev.decisionId), "single-use id of the agent's decision")}
        ${row("", "regime", String(ev.regime), `<b>${esc(ev.regimeName)}</b>`)}
        ${row("row-gates", "gatesMask", `0b${ev.gatesMask.toString(2)}`, `<b>${esc(ev.gateNames.join(" + "))}</b>`)}
        ${row("", "caller", sh(ev.caller), isOp ? "= the lane's <b>operator()</b>: the Dynamic-delegated Operator wallet" : "not the lane's operator")}
        ${row("", "reasonHash", sh(ev.reasonHash), "keccak256 of the agent's reasoning record")}
      </table>
      ${check ? `<div class="card fade row-check" style="${d(0.8)}padding:12px 18px;border-left:4px solid ${ok ? "#0a7f4f" : "var(--neg)"}">
        <div style="font-size:17px;font-weight:600">${ok ? "✓" : "✗"} keccak256(preimage) ${ok ? "=" : "≠"} reasonHash <span class="mono" style="font-weight:400;font-size:14px;color:var(--ink-2)">${esc(check.hash ? sh(check.hash) : "cast not available")}</span></div>
        <div class="mono" style="font-size:12.5px;color:var(--ink-2);margin-top:4px;word-break:break-all">${esc(check.preimage)}</div></div>` : ""}
      <p class="src" style="margin-top:auto">Receipt fetched live at recording time (eth_getTransactionReceipt; owner/operator via eth_call). ABI: contracts/src/interfaces/IDeskLane.sol; names: IDeskTypes.Action and agent/src/types.ts. Preimage: the agent's gate_signals record in docs/m2-desk.md §3b, hashed with Foundry's cast keccak at recording time.</p>
    </div>`,
    { css: ".k{padding:6px 18px 6px 0;color:var(--ink-2);white-space:nowrap}.raw{padding:6px 22px 6px 0;font-size:14px;color:var(--muted);white-space:nowrap}.v{padding:6px 0}" },
  );
}

// Caption strip for burned-in subtitles: transparent 1280x140 CSS px, text centred near the bottom.
export function captionStrip(text) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@500&display=block" rel="stylesheet">
<style>html{width:100%;height:100%;overflow:hidden;background:transparent}body{margin:0;width:1280px;height:140px;background:transparent;overflow:hidden;position:relative}
.c{position:absolute;left:0;right:0;bottom:6px;display:flex;justify-content:center}
.c span{max-width:1060px;text-align:center;font:500 25px/1.32 "Geist",system-ui,sans-serif;color:#fff;background:rgba(11,11,11,.78);
padding:7px 16px;border-radius:9px;-webkit-box-decoration-break:clone;box-decoration-break:clone}</style></head>
<body><div class="c"><span>${esc(text)}</span></div></body></html>`;
}

// The live 402 response of an x402 endpoint, rendered legibly (same data, bigger type).
export function x402View({ url, status, body }) {
  const a = body?.accepts?.[0] ?? {};
  const usdc = a.amount ? `$${(Number(a.amount) / 1e6).toFixed(3).replace(/0$/, "")} USDC` : "–";
  const net = a.network === "eip155:8453" ? "Base (eip155:8453)" : a.network ?? "–";
  const kv = (k, v, strong) => `<tr><td style="padding:7px 18px 7px 0;color:var(--ink-2);white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:7px 0;${strong ? "font-weight:600;font-size:22px" : ""}">${v}</td></tr>`;
  return page(
    `<div class="wrap" style="padding:44px 80px 100px">
      <div class="mono" style="font-size:15px;color:var(--ink-2);word-break:break-all"><span style="color:var(--accent);font-weight:500">GET</span> ${esc(url)}</div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:14px">
        <span style="background:#fab219;color:#1a1400;font-weight:700;font-size:20px;padding:6px 12px;border-radius:8px">HTTP ${esc(status)}</span>
        <span style="font-size:28px;font-weight:600">${esc(body?.error ?? "")}</span>
        <span style="font-size:16px;color:var(--muted)">x402 v${esc(body?.x402Version ?? "")} · unpaid request, so the endpoint answers with its terms</span>
      </div>
      <table class="card" style="margin-top:22px;padding:14px 22px;font-size:17px;border-collapse:separate;display:block">
        ${kv("Price", esc(usdc), true)}
        ${kv("Network", esc(net))}
        ${kv("Asset", `<span class="mono" style="font-size:15px">${esc(a.extra?.name ?? "")} ${esc(a.asset ?? "")}</span>`)}
        ${kv("Pay to", `<span class="mono" style="font-size:15px">${esc(a.payTo ?? "")}</span>`)}
        ${kv("Facilitator", `<span class="mono" style="font-size:15px">${esc(body?.facilitator ?? "")}</span>`)}
        ${kv("Service", `<span style="line-height:1.4;display:block;max-width:900px">${esc(a.description ?? "")}</span>`)}
      </table>
    </div>`,
  );
}
