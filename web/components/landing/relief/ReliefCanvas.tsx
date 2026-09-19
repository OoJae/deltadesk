"use client";

import { useEffect, useRef, useState } from "react";
import { ACTS, LAST_FRAME } from "../acts";
import { HERO, actAt, buildKeys, stateAt, type HeroFit, type Key } from "./choreography";
import { BLADE, FENCE, RELIEF_URL, WORLD, frameAt, usd, type ReliefData } from "./data";
import type { ReliefEngine } from "./engine";
import { placeTags, type Box } from "./tags";

/**
 * The WebGL relief and its instrument readout. Mounted by EngravedBook through next/dynamic (ssr:false), so three and
 * this file load only on /. Scroll drives it directly (window scroll events, which Lenis fires too): no gsap here.
 * Skipped entirely under reduced motion or without WebGL: the engraved SVG poster (server-rendered beside it) then
 * stays as the figure.
 */
export default function ReliefCanvas({ bookId }: { bookId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const book = document.getElementById(bookId);
    const stage = canvas?.parentElement;
    if (!canvas || !book || !stage) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2")) return;

    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const [{ createRelief }, res] = await Promise.all([import("./engine"), fetch(RELIEF_URL)]);
      const data = (await res.json()) as ReliefData;
      if (disposed) return;

      const narrowQuery = window.matchMedia("(max-width: 767px)");
      const lite = narrowQuery.matches || (navigator.hardwareConcurrency ?? 8) <= 4;
      let engine: ReliefEngine;
      try {
        engine = createRelief(canvas, data, lite ? "lite" : "full");
      } catch {
        return; // no WebGL after all: the poster stays
      }
      canvas.dataset.segments = String(engine.segments);

      const hud = hudRef.current!;
      const q = <T extends HTMLElement>(sel: string) => hud.querySelector<T>(sel)!;
      const el = {
        time: q("[data-hud=time]"),
        act: q("[data-hud=act]"),
        pool: q("[data-hud=pool]"),
        fair: q("[data-hud=fair]"),
        gap: q("[data-hud=gap]"),
        fence: q("[data-hud=fence]"),
        risk: q("[data-hud=risk]"),
        lane: q("[data-hud=lane]"),
        control: q("[data-hud=control]"),
        needle: q("[data-hud=needle]"),
        poolLabel: q("[data-hud=pool-label]"),
        fairLabel: q("[data-hud=fair-label]"),
        laneLabel: q("[data-hud=lane-label]"),
      };

      let keys: Key[] = [];
      let bookTop = 0;
      let heroEnd = 0;
      let visible = true;
      let dirty = true;
      let raf = 0;
      let lastFrameIdx = -1;
      let lastAct = -2;
      let stageW = 1;
      let stageH = 1;
      let fixed: Box[] = []; // readout + timeline, in stage px
      const panels = Array.from(book.querySelectorAll<HTMLElement>(".book-panel > article"));
      const heroCopy = Array.from(book.querySelectorAll<HTMLElement>("[data-hero-copy]"));
      const size = { pool: [0, 0], fair: [0, 0], lane: [0, 0] };

      const rel = (r: DOMRect, o: DOMRect): Box => ({ x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height });

      /**
       * Desktop hero: frame the plate between the copy and the security border, so no engraved line runs under the
       * headline, lede, buttons or serial line, while its front edge (Monday's open) stays inside the frame; the far
       * corner may bleed off the right. The view shift is a pure screen translation, so project the plate once unshifted
       * per camera distance, then take the nearest distance whose plate fits.
       */
      const fitHero = (acts: [number, number][]): HeroFit => {
        if (narrowQuery.matches || !heroCopy.length) return HERO;
        const origin = book.getBoundingClientRect();
        const bands: { top: number; bottom: number; right: number }[] = [];
        const range = document.createRange();
        for (const root of heroCopy) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim()) continue;
            range.selectNodeContents(n);
            // Headline lines rise in from a mask: take their height from the (unmoving) line box.
            const line = n.parentElement?.closest(".dd-hero-line")?.getBoundingClientRect();
            for (const r of Array.from(range.getClientRects())) {
              const v = line ?? r;
              bands.push({ top: v.top - origin.top, bottom: v.bottom - origin.top, right: r.right - origin.left });
            }
          }
          for (const a of Array.from(root.querySelectorAll("a, button"))) {
            const r = a.getBoundingClientRect();
            bands.push({ top: r.top - origin.top, bottom: r.bottom - origin.top, right: r.right - origin.left });
          }
        }
        const AIR = 40; // px between the copy and the nearest engraved line
        const edge = stageW - 44; // inside the frame's right rail
        const pts = engine.outline;
        let front = -Infinity;
        for (let k = 2; k < pts.length; k += 3) front = Math.max(front, pts[k]);
        let best: HeroFit = HERO;
        for (let dist = HERO.dist; dist <= HERO.dist * 1.6 + 0.01; dist += HERO.dist * 0.075) {
          engine.setState(stateAt(buildKeys(acts, window.innerHeight, false, { shiftX: 0, dist }), 0, data, engine));
          let need = 0;
          let right = -Infinity;
          for (let k = 0; k < pts.length; k += 3) {
            const p = engine.project(pts[k], pts[k + 1], pts[k + 2]);
            if (!p) continue;
            if (pts[k + 2] >= front - 1e-4) right = Math.max(right, p[0]);
            for (const b of bands) if (p[1] > b.top - 16 && p[1] < b.bottom + 16) need = Math.max(need, b.right + AIR - p[0]);
          }
          const lo = need; // least shift that clears the copy
          const hi = edge - right; // most shift before the front edge crosses the frame
          best = { dist, shiftX: Math.min(Math.max(HERO.shiftX * stageW, lo), Math.max(lo, hi)) / stageW };
          if (lo <= hi) break;
        }
        return best;
      };

      const measure = () => {
        const r = stage.getBoundingClientRect();
        stageW = Math.max(1, r.width);
        stageH = Math.max(1, r.height);
        engine.resize(r.width, r.height);
        const b = book.getBoundingClientRect();
        bookTop = b.top + window.scrollY;
        const acts = Array.from(book.querySelectorAll<HTMLElement>("li[data-act]")).map((a) => {
          const ar = a.getBoundingClientRect();
          return [ar.top + window.scrollY - bookTop, ar.bottom + window.scrollY - bookTop] as [number, number];
        });
        const hero = fitHero(acts);
        canvas.dataset.hero = `${hero.dist.toFixed(1)} ${hero.shiftX.toFixed(3)}`;
        keys = buildKeys(acts, window.innerHeight, narrowQuery.matches, hero);
        heroEnd = acts.length ? acts[0][0] - 0.1 * window.innerHeight : 0;
        fixed = [hud.querySelector(".relief-readout"), hud.querySelector(".relief-timeline")]
          .map((n) => n?.getBoundingClientRect())
          .filter((q): q is DOMRect => !!q && q.width > 0 && q.height > 0)
          .map((q) => rel(q, r));
        dirty = true;
      };

      const place = (node: HTMLElement, box: Box | null) => {
        if (!box) {
          node.style.opacity = "0";
          return;
        }
        node.style.opacity = "1";
        node.style.transform = `translate3d(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px, 0)`;
      };

      const draw = () => {
        raf = 0;
        if (!visible || !dirty) return;
        dirty = false;
        // Reads first (layout is clean at the top of the frame): the stage and the act panels on screen.
        const sr = stage.getBoundingClientRect();
        const obstacles = fixed.slice();
        for (const a of panels) {
          const pr = a.getBoundingClientRect();
          if (pr.bottom > sr.top && pr.top < sr.bottom) obstacles.push(rel(pr, sr));
        }

        const s = window.scrollY - bookTop;
        const st = stateAt(keys, s, data, engine);
        engine.setState(st);
        engine.render();

        const fi = Math.max(0, Math.min(LAST_FRAME, Math.round(st.frame)));
        const act = actAt(keys, s, heroEnd);
        let resized = false;
        if (act !== lastAct) {
          lastAct = act;
          hud.dataset.phase = String(act);
          el.act.textContent = act >= 0 ? `N° ${String(act + 1).padStart(2, "0")}` : "";
          lastFrameIdx = -1; // the lane tag's words depend on the act
        }
        if (fi !== lastFrameIdx) {
          lastFrameIdx = fi;
          const f = data.frames[fi];
          el.time.textContent = `${f.et} ET`;
          el.pool.textContent = f.poolMid.toFixed(2);
          el.fair.textContent = f.fair.toFixed(2);
          const gap = Math.round(f.gapBps * 10) / 10; // no "−0.0"
          el.gap.textContent = `${gap > 0 ? "+" : gap < 0 ? "−" : ""}${Math.abs(gap).toFixed(1)} bp`;
          el.fence.textContent = `${f.fence} ${FENCE[f.fence] ?? ""}`;
          el.risk.textContent = f.risk ? "allowed" : "blocked";
          el.risk.dataset.on = String(f.risk);
          el.lane.textContent = f.laneIn == null ? "–" : f.laneIn ? "in range" : "out of range";
          el.control.textContent = `${usd(data.control.pickedCents[fi])} / ${usd(data.control.feeCents[fi])}`;
          el.needle.style.transform = `scaleX(${(fi / LAST_FRAME).toFixed(4)})`;
          el.poolLabel.lastElementChild!.textContent = f.poolMid.toFixed(2);
          el.fairLabel.lastElementChild!.textContent = f.fair.toFixed(2);
          el.laneLabel.lastElementChild!.textContent = act === 4 ? "planned re-center on fair value" : f.laneIn ? "held · in range" : "held · out of range";
          resized = true;
        }
        if (resized || size.pool[0] === 0) {
          // The tags' words just changed: one small layout read for their sizes.
          size.pool = [el.poolLabel.offsetWidth, el.poolLabel.offsetHeight];
          size.fair = [el.fairLabel.offsetWidth, el.fairLabel.offsetHeight];
          size.lane = [el.laneLabel.offsetWidth, el.laneLabel.offsetHeight];
        }

        // Blade tags ride the blades' tops, then step off each other and off the panels.
        const pt = data.frames[fi].poolTick;
        const ft = data.frames[fi].fairTick;
        const zf = engine.z(st.frame);
        const h = WORLD.height * BLADE;
        const showBlades = st.blades > 0.5;
        const ft2 = frameAt(data, st.frame, "fairTick");
        const laneX = engine.x(data.lane.upper) + (engine.x(ft2) - (engine.x(data.lane.upper) + engine.x(data.lane.lower)) / 2) * st.recenter;
        const narrow = narrowQuery.matches;
        const placed = placeTags(
          { w: stageW, h: stageH, minY: narrow ? 84 : 40 },
          obstacles,
          { anchor: engine.project(engine.x(pt), engine.crest(st.frame, pt) + h, zf), w: size.pool[0], h: size.pool[1], show: showBlades },
          { anchor: engine.project(engine.x(ft), engine.crest(st.frame, ft) + h, zf), w: size.fair[0], h: size.fair[1], show: showBlades },
          {
            anchor: engine.project(laneX, engine.laneTop(st) + 0.08, zf - 0.3),
            w: size.lane[0],
            h: size.lane[1],
            show: !narrow && st.lane > 0.5 && act >= 3,
          },
        );
        place(el.poolLabel, placed.pool);
        place(el.fairLabel, placed.fair);
        place(el.laneLabel, placed.lane);
      };

      const request = () => {
        dirty = true;
        if (!raf && visible) raf = requestAnimationFrame(draw);
      };
      const remeasure = () => {
        measure();
        request();
      };

      window.addEventListener("scroll", request, { passive: true });
      const ro = new ResizeObserver(remeasure);
      ro.observe(stage);
      ro.observe(book);
      const io = new IntersectionObserver(([e]) => {
        visible = e.isIntersecting && document.visibilityState === "visible";
        if (visible) request();
      });
      io.observe(book);
      const onVis = () => {
        visible = document.visibilityState === "visible";
        if (visible) request();
      };
      document.addEventListener("visibilitychange", onVis);
      // The headline's width settles once its face has loaded; the hero fit depends on it.
      document.fonts?.ready.then(() => {
        if (!disposed) remeasure();
      });

      measure();
      draw();
      setReady(true);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("scroll", request);
        ro.disconnect();
        io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        engine.dispose();
      };
    })().catch(() => {
      /* the poster stays */
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [bookId]);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden="true" data-ready={ready ? "true" : undefined} className="relief-canvas absolute inset-0 h-full w-full" />
      <div ref={hudRef} aria-hidden="true" data-ready={ready ? "true" : undefined} data-phase="-1" className="relief-hud pointer-events-none absolute inset-0">
        {/* Instrument panel: every value is the replay's, at the frame on screen. */}
        <dl className="relief-readout font-mono">
          <div className="relief-readout-head">
            <span data-hud="act" className="text-serial" />
            <span data-hud="time" className="text-paper" />
          </div>
          <div>
            <dt>Pool</dt>
            <dd data-hud="pool" />
          </div>
          <div>
            <dt>Fair value</dt>
            <dd data-hud="fair" className="text-serial" />
          </div>
          <div className="relief-gap">
            <dt>Gap</dt>
            <dd data-hud="gap" className="text-serial" />
          </div>
          <div className="relief-wide">
            <dt>Fence</dt>
            <dd data-hud="fence" />
          </div>
          <div className="relief-wide">
            <dt>Risk-adding</dt>
            <dd data-hud="risk" />
          </div>
          <div className="relief-wide">
            <dt>Lane A</dt>
            <dd data-hud="lane" />
          </div>
          <div className="relief-control">
            <dt>$1k LP taken / fees</dt>
            <dd data-hud="control" />
          </div>
        </dl>

        <span data-hud="pool-label" className="relief-tag font-mono">
          <span className="text-paper-mute">Pool</span>
          <span className="text-paper" />
        </span>
        <span data-hud="fair-label" className="relief-tag font-mono">
          <span className="text-paper-mute">Fair</span>
          <span className="text-serial" />
        </span>
        <span data-hud="lane-label" className="relief-tag relief-tag--lane font-mono">
          <span className="text-paper">Lane A · $50</span>
          <span className="text-paper-dim" />
        </span>

        <div className="relief-timeline font-mono">
          <div className="relief-track">
            <span data-hud="needle" className="relief-needle" />
            {ACTS.map((a) => (
              <span key={a.n} className="relief-mark" style={{ left: `${(a.frames[0] / LAST_FRAME) * 100}%` }}>
                {String(a.n).padStart(2, "0")}
              </span>
            ))}
          </div>
          <div className="relief-ends">
            <span>Fri 16:00</span>
            <span>Mon 09:45 ET</span>
          </div>
        </div>
      </div>
    </>
  );
}
