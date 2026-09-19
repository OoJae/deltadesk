// Scene harness: one browser context per scene with recordVideo at 1920x1080, an injected overlay
// (cursor highlight, caption bar, LIVE / REPLAY badge), deterministic waits, eased scrolling and cursor moves,
// and pacing against the beat's duration so the picture lines up with the narration.
import { mkdirSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const VIDEO = { width: 1920, height: 1080 };

// Injected into every document (init script) and re-applied after setContent. Idempotent.
function overlayScript(o) {
  const Z = o.zoom || 1;
  const apply = () => {
    if (!document.body || document.getElementById("dd-overlay-style")) return;
    const root = document.documentElement; // overlays live outside the zoomed <body>
    const st = document.createElement("style");
    st.id = "dd-overlay-style";
    st.textContent = `
body{zoom:${Z}}
#dd-bar,#dd-replay{zoom:${Z}}
#dd-cursor{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
  background:rgba(250,178,25,.28);border:3.5px solid rgba(250,178,25,.95);box-shadow:0 0 0 7px rgba(250,178,25,.12);
  pointer-events:none;z-index:2147483646;transition:transform .12s ease, opacity .3s;opacity:0}
#dd-cursor.on{opacity:1} #dd-cursor.down{transform:scale(.72)}
.dd-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:4px solid rgba(250,178,25,.9);
  pointer-events:none;z-index:2147483645;animation:ddr .6s ease-out forwards}
@keyframes ddr{to{transform:scale(3);opacity:0}}
#dd-bar{position:fixed;left:0;right:0;bottom:0;height:44px;display:flex;align-items:center;gap:12px;padding:0 18px;
  background:rgba(11,11,11,.9);color:#f3f2ee;font:500 14px/1 "Geist",system-ui,-apple-system,sans-serif;z-index:2147483644;
  letter-spacing:.005em;backdrop-filter:blur(6px)}
#dd-bar .b{font-weight:700;font-size:12px;letter-spacing:.12em;padding:5px 9px;border-radius:6px;display:inline-flex;align-items:center;gap:7px}
#dd-bar .b.live{background:#0e7a4c} #dd-bar .b.live i{width:8px;height:8px;border-radius:50%;background:#7dffc4;display:block;animation:ddp 1.4s infinite}
#dd-bar .b.replay{background:#fab219;color:#1a1400} #dd-bar .b.card{background:#3a3b3f} #dd-bar .b.pending{background:#6b6a66}
@keyframes ddp{50%{opacity:.35}}
#dd-bar .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dd-bar .u{margin-left:auto;color:#b9b7ae;font:400 12.5px/1 "Geist Mono",ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48%}
#dd-replay{position:fixed;top:74px;right:22px;z-index:2147483644;background:#fab219;color:#1a1400;border-radius:10px;
  padding:9px 14px;font:700 15px/1.2 "Geist",system-ui,sans-serif;letter-spacing:.1em;box-shadow:0 6px 24px rgba(0,0,0,.18)}
#dd-replay small{display:block;font-weight:500;letter-spacing:.01em;font-size:12px;margin-top:2px}
#dd-tag{position:fixed;top:74px;right:22px;z-index:2147483644;background:rgba(11,11,11,.9);color:#f3f2ee;border-radius:10px;zoom:${Z};
  padding:10px 14px;font:600 15px/1.3 "Geist",system-ui,sans-serif;max-width:560px;box-shadow:0 6px 24px rgba(0,0,0,.2);border-left:4px solid #fab219}
#dd-tag small{display:block;font-weight:400;font-size:12.5px;color:#cfcdc6;margin-top:3px}
.dd-hl{position:absolute;pointer-events:none;z-index:2147483640;border-radius:14px;border:4.5px solid #fab219;
  box-shadow:0 0 0 9px rgba(250,178,25,.18);animation:ddhl .35s ease-out}
@keyframes ddhl{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:none}}`;
    document.head.appendChild(st);
    const cur = document.createElement("div");
    cur.id = "dd-cursor";
    if (o.cursor) root.appendChild(cur);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; cur.classList.add("on"); }, true);
    addEventListener("mousedown", (e) => {
      cur.classList.add("down");
      const r = document.createElement("div");
      r.className = "dd-ripple"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      root.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
    if (window.__ddCursor) { cur.style.left = window.__ddCursor.x + "px"; cur.style.top = window.__ddCursor.y + "px"; cur.classList.add("on"); }
    if (o.bar) {
      const bar = document.createElement("div");
      bar.id = "dd-bar";
      const badge = o.mode === "REPLAY" ? '<span class="b replay">REPLAY</span>'
        : o.mode === "LIVE" ? '<span class="b live"><i></i>LIVE</span>'
        : `<span class="b ${o.mode === "PENDING" ? "pending" : "card"}">${o.mode}</span>`;
      bar.innerHTML = `${badge}<span class="t"></span><span class="u"></span>`;
      bar.querySelector(".t").textContent = o.title;
      bar.querySelector(".u").textContent = o.url || location.href.replace(/^https?:\/\//, "");
      root.appendChild(bar);
    }
    if (o.mode === "REPLAY") {
      const rb = document.createElement("div");
      rb.id = "dd-replay";
      rb.innerHTML = `REPLAY<small></small>`;
      rb.querySelector("small").textContent = o.replayNote || "historical data, not live";
      root.appendChild(rb);
    }
  };
  // Mid-scene relabels, re-applied on every document from the harness's current state (exposed function), so a
  // relabel set before a navigation shows on the new page's first painted overlay.
  window.__ddApplyChrome = ({ bar, tag } = {}) => {
    const b = document.getElementById("dd-bar");
    if (b && bar) {
      if (bar.title != null) b.querySelector(".t").textContent = bar.title;
      if (bar.url != null) b.querySelector(".u").textContent = bar.url;
    }
    document.getElementById("dd-tag")?.remove();
    if (tag && document.getElementById("dd-overlay-style")) {
      const d = document.createElement("div");
      d.id = "dd-tag";
      d.textContent = tag.text;
      if (tag.pos) for (const k of ["top", "left", "right", "bottom"]) d.style[k] = tag.pos[k] == null ? "auto" : `${tag.pos[k]}px`;
      if (tag.sub) {
        const sm = document.createElement("small");
        sm.textContent = tag.sub;
        d.appendChild(sm);
      }
      document.documentElement.appendChild(d);
    }
  };
  // Highlights follow their elements every frame (explorers keep shifting rows while they load).
  window.__ddPlace = (d) => {
    const rs = (d.__els || []).filter((e) => e && e.isConnected).map((e) => e.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (!rs.length) return;
    const p = d.__pad * (parseFloat(getComputedStyle(document.body).zoom) || 1);
    const x0 = Math.min(...rs.map((r) => r.left)), y0 = Math.min(...rs.map((r) => r.top));
    const x1 = Math.max(...rs.map((r) => r.right)), y1 = Math.max(...rs.map((r) => r.bottom));
    Object.assign(d.style, { left: `${x0 + scrollX - p}px`, top: `${y0 + scrollY - p}px`, width: `${x1 - x0 + 2 * p}px`, height: `${y1 - y0 + 2 * p}px` });
  };
  window.__ddHighlight = (els, pad) => {
    const d = document.createElement("div");
    d.className = "dd-hl";
    d.__els = els;
    d.__pad = pad;
    document.documentElement.appendChild(d);
    window.__ddPlace(d);
    if (!window.__ddLoop) {
      window.__ddLoop = true;
      const tick = () => {
        document.querySelectorAll(".dd-hl").forEach((x) => window.__ddPlace(x));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  };
  const pull = () => window.__ddChromeState?.().then((st) => st && window.__ddApplyChrome(st)).catch(() => {});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { apply(); pull(); });
  else { apply(); pull(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export async function recordScene(browser, { cfg, beat, outDir, overlay = {} }, fn) {
  const tmp = join(outDir, `.tmp-${beat.id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Native 1920x1080 viewport (the video is captured at CSS size); pages are laid out at 1920/zoom CSS px via body zoom.
  const vp = { width: VIDEO.width, height: VIDEO.height };
  const zoom = cfg.zoom ?? 1.5;
  const context = await browser.newContext({
    viewport: vp,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/New_York",
    recordVideo: { dir: tmp, size: VIDEO },
  });
  const recordedAt = new Date();
  const stamp = recordedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const ov = {
    zoom,
    bar: true,
    cursor: overlay.cursor ?? overlay.bar !== false, // static cards (no caption bar) hide the cursor
    mode: beat.mode === "CARD" ? "CARD" : beat.mode,
    title: overlay.title ?? `${beat.title}${beat.mode === "LIVE" ? ` · recorded ${stamp}` : ""}`,
    url: overlay.url ?? "",
    replayNote: overlay.replayNote,
    ...overlay,
  };
  let barPatch = null, tagSpec = null; // mid-scene relabels (see s.bar / s.tag)
  await context.exposeFunction("__ddChromeState", () => (barPatch || tagSpec ? { bar: barPatch, tag: tagSpec } : null));
  await context.addInitScript(overlayScript, ov);
  const page = await context.newPage();
  const t0 = Date.now();
  let tStart = null;
  const mouse = { x: vp.width * 0.62, y: vp.height * 0.55 };
  const applyChrome = async () => {
    if (!barPatch && !tagSpec) return;
    await page.evaluate((st) => window.__ddApplyChrome?.(st), { bar: barPatch, tag: tagSpec }).catch(() => {});
  };

  const s = {
    page,
    cfg,
    beat,
    duration: beat.duration,
    log: (...a) => console.log(`  [${beat.id}]`, ...a),
    ph: (k) => (cfg.placeholders?.[k] ?? "").trim(),

    // waitUntil "networkidle" suits our own app; explorers poll forever, so pass { idle: false } and a waitFor selector.
    // { bar, tag } relabel the new page from its first painted overlay (the current page keeps its labels).
    async goto(url, { waitFor, timeout = 60000, settle = 400, idle = true, bar, tag } = {}) {
      if (bar) barPatch = { ...(barPatch ?? {}), ...bar };
      if (tag !== undefined) tagSpec = tag ? { text: tag.text, sub: tag.sub ?? "", pos: tag.pos ?? null } : null;
      const res = await page.goto(url, { waitUntil: idle ? "networkidle" : "domcontentloaded", timeout }).catch(async (e) => {
        // networkidle can starve on pages with long polling; fall back to load + selector
        s.log(`networkidle not reached (${e.message.split("\n")[0]}), falling back to load`);
        return page.goto(url, { waitUntil: "load", timeout });
      });
      if (waitFor) await page.locator(waitFor).filter({ visible: true }).first().waitFor({ state: "visible", timeout });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await applyChrome();
      await sleep(settle);
      await s.syncCursor();
      return res;
    },

    // Load a URL once in a throwaway tab of the same context (warms HTTP and server caches), so the
    // on-camera navigation later renders fast. Nothing from that tab ends up in the scene's video.
    async warm(url, waitFor, { timeout = 90000 } = {}) {
      const t = Date.now();
      const p2 = await context.newPage();
      try {
        await p2.goto(url, { waitUntil: "load", timeout });
        if (waitFor) await p2.locator(waitFor).filter({ visible: true }).first().waitFor({ state: "visible", timeout });
      } catch (e) {
        s.log(`warm ${url}: ${e.message.split("\n")[0]}`);
      } finally {
        await p2.close();
      }
      s.log(`warmed ${url.replace(/^https?:\/\//, "").slice(0, 60)} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    },

    async setContent(html, { settle = 300 } = {}) {
      // Zoom (and, mid-scene, the "go" class that runs the fade-ins) are in the markup itself, so a card swapped in
      // after start() never shows a frame at the wrong scale or with its content still hidden.
      html = html.replace("</head>", `<style>body{zoom:${zoom}}</style></head>`);
      if (tStart) html = html.replace(/<body(\s|>)/, '<body class="go"$1');
      await page.setContent(html, { waitUntil: "networkidle" });
      await page.evaluate(overlayScript, ov);
      await applyChrome();
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await sleep(settle);
      await s.syncCursor();
    },

    // Relabel the caption bar mid-scene ({ title, url }); it sticks across later navigations.
    async bar(patch) {
      barPatch = { ...(barPatch ?? {}), ...patch };
      await applyChrome();
    },
    // A labelled tag (e.g. what an explorer page is evidence of); tag(null) removes it. Default: top-right corner;
    // pos = { top, left, right, bottom } in page CSS px (the 1280-wide layout) places it elsewhere.
    async tag(text, sub = "", pos = null) {
      tagSpec = text ? { text, sub, pos } : null;
      if (!tagSpec) await page.evaluate(() => document.getElementById("dd-tag")?.remove()).catch(() => {});
      await applyChrome();
    },
    // The first *visible* match of a selector or locator, or null. With { timeout }, waits for one first.
    // Explorers render skeletons and duplicate hidden nodes, so scenes highlight only what this returns.
    async visible(target, { timeout = 0 } = {}) {
      const loc = (typeof target === "string" ? page.locator(target) : target).filter({ visible: true }).first();
      if (timeout) await loc.waitFor({ state: "visible", timeout }).catch(() => {});
      return (await loc.isVisible().catch(() => false)) ? loc : null;
    },

    // Wait until an element stops moving (explorers keep inserting rows above it while they load), so a
    // document-positioned highlight drawn next stays on it. Returns false if it never settled within `timeout`.
    async stable(target, { ms = 700, timeout = 6000 } = {}) {
      const loc = typeof target === "string" ? page.locator(target).first() : target;
      const t = Date.now();
      let last = null, since = Date.now();
      while (Date.now() - t < timeout) {
        const b = await loc.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.left + scrollX)},${Math.round(r.top + scrollY)},${Math.round(r.width)},${Math.round(r.height)}`;
        }).catch(() => null);
        if (b !== last) { last = b; since = Date.now(); }
        else if (b && Date.now() - since >= ms) return true;
        await sleep(100);
      }
      s.log(`stable: element still moving after ${timeout} ms`);
      return false;
    },

    // First frame of the usable scene; the build trims everything before it.
    async start() {
      await page.evaluate(() => document.body.classList.add("go")).catch(() => {});
      tStart = Date.now();
    },
    elapsed() {
      return tStart ? (Date.now() - tStart) / 1000 : 0;
    },
    // Wait until `frac` of the beat duration has elapsed since start().
    async until(frac) {
      const ms = frac * s.duration * 1000 - (Date.now() - tStart);
      if (ms > 0) await sleep(ms);
    },
    async wait(ms) {
      await sleep(ms);
    },

    async syncCursor() {
      await page.evaluate(({ x, y }) => { window.__ddCursor = { x, y }; }, mouse).catch(() => {});
      await page.mouse.move(mouse.x, mouse.y).catch(() => {});
    },

    async moveTo(target, { ms = 900, dx = 0, dy = 0 } = {}) {
      let x, y;
      if (typeof target === "string" || target?.boundingBox) {
        const loc = typeof target === "string" ? page.locator(target).first() : target;
        const box = await loc.boundingBox({ timeout: 5000 });
        if (!box) throw new Error(`moveTo: no box for ${target}`);
        x = box.x + box.width / 2 + dx;
        y = box.y + box.height / 2 + dy;
      } else ({ x, y } = target);
      const from = { ...mouse };
      const steps = Math.max(8, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const k = ease(i / steps);
        mouse.x = from.x + (x - from.x) * k;
        mouse.y = from.y + (y - from.y) * k;
        await page.mouse.move(mouse.x, mouse.y);
        await sleep(ms / steps);
      }
    },

    async click(target, opts = {}) {
      await s.moveTo(target, opts);
      await sleep(180);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
    },

    // Eased scroll so that `target` (selector | locator | y) sits `offset` px below the top.
    async scrollTo(target, { ms = 1200, offset = 96 } = {}) {
      let y;
      if (typeof target === "number") y = target;
      else {
        const loc = typeof target === "string" ? page.locator(target).first() : target;
        await loc.waitFor({ state: "attached" });
        y = await loc.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off * (parseFloat(getComputedStyle(document.body).zoom) || 1), offset);
      }
      await page.evaluate(
        ({ y, ms }) =>
          new Promise((resolve) => {
            const max = document.documentElement.scrollHeight - innerHeight;
            const to = Math.max(0, Math.min(max, y)), from = scrollY, t0 = performance.now();
            const e = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
            const step = (t) => {
              const k = Math.min(1, (t - t0) / ms);
              scrollTo(0, from + (to - from) * e(k));
              k < 1 ? requestAnimationFrame(step) : resolve();
            };
            requestAnimationFrame(step);
          }),
        { y, ms },
      );
      await sleep(120);
    },

    // Outline an element (document-positioned, and re-placed every frame, so it stays on the element while the
    // page scrolls or shifts).
    async highlight(target, { pad = 8, ms = 0 } = {}) {
      const loc = typeof target === "string" ? page.locator(target).first() : target;
      const el = await loc.elementHandle({ timeout: 5000 });
      await page.evaluate(([el, pad]) => window.__ddHighlight([el], pad), [el, pad]);
      await el.dispose();
      if (ms) {
        await sleep(ms);
        await s.clearHighlights();
      }
    },
    // One outline around several elements (e.g. a label and its values on an explorer page).
    async highlightUnion(targets, { pad = 8 } = {}) {
      const els = [];
      for (const t of targets) {
        const loc = typeof t === "string" ? page.locator(t).first() : t;
        const h = await loc.elementHandle({ timeout: 2000 }).catch(() => null);
        if (h) els.push(h);
      }
      if (!els.length) return;
      await page.evaluate(([els, pad]) => window.__ddHighlight(els, pad), [els, pad]);
      await Promise.all(els.map((h) => h.dispose()));
    },
    async clearHighlights() {
      await page.evaluate(() => document.querySelectorAll(".dd-hl").forEach((e) => e.remove()));
    },
  };

  let error = null;
  try {
    await fn(s);
    if (!tStart) throw new Error("scene never called start()");
    await s.until(1);
    await sleep(300); // tail so the trim never runs short
  } catch (e) {
    error = e;
  }
  const video = page.video();
  await context.close();
  const files = readdirSync(tmp).filter((f) => f.endsWith(".webm"));
  if (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  const out = join(outDir, `${beat.id}.webm`);
  if (video) await video.saveAs(out).catch(() => renameSync(join(tmp, files[0]), out));
  else renameSync(join(tmp, files[0]), out);
  rmSync(tmp, { recursive: true, force: true });
  const meta = { id: beat.id, offset: (tStart - t0) / 1000, duration: beat.duration, recordedAt: recordedAt.toISOString(), mode: beat.mode, video: `${beat.id}.webm` };
  writeFileSync(join(outDir, `${beat.id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}
