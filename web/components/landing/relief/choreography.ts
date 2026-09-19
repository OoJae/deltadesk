// Scroll → scene. Each act holds its camera while its frames play (time runs linearly with scroll), then the camera
// travels to the next act (eased). Keyframe positions come from the act panels' real offsets, so the text and the
// relief stay in step at any viewport height.

import { ACTS, LAST_FRAME } from "../acts";
import { frameAt, type ReliefData } from "./data";
import type { ReliefState } from "./engine";

type Shot = Omit<ReliefState, "frame" | "tx" | "ty" | "tz"> & { focus: "pool" | "lane" | "plate" };
export type Key = { at: number; frame: number; shot: Shot; hold: boolean };

const BASE = { burn: 0, flow: 0, gap: 0, blades: 1, lane: 1, lift: 0, recenter: 0, closedDim: 0, fov: 30, ink: 1 };

/** The hero's default framing (desktop): the plate sits right of the headline. */
export const HERO = { shiftX: 0.25, dist: 22.5 };
export type HeroFit = typeof HERO;

/**
 * Camera and layer settings per act, [start, end]. Desktop numbers; `narrow` adjusts for portrait screens.
 * `hero` overrides the desktop hero's framing (ReliefCanvas fits the plate between the headline and the frame).
 */
function shots(narrow: boolean, hero: HeroFit = HERO): { hero: Shot; acts: [Shot, Shot][] } {
  const sx = narrow ? 0 : 0.14;
  const syAct = narrow ? -0.2 : 0.1;
  const k = narrow ? 1.55 : 1;
  const s = (o: Partial<Shot>): Shot => ({ ...BASE, shiftX: sx, shiftY: syAct, yaw: 0, elev: 20, focus: "pool", ...o, dist: (o.dist ?? 7) * k });
  return {
    hero: s({ focus: "plate", yaw: 30, elev: 26, dist: narrow ? HERO.dist : hero.dist, blades: 0, lane: 0, shiftX: narrow ? 0 : hero.shiftX, shiftY: narrow ? 0.34 : -0.06, fov: 30, ink: narrow ? 0.55 : 0.8 }),
    acts: [
      [s({ yaw: -8, elev: 11, dist: 13, lane: 0.6 }), s({ yaw: -4, elev: 14, dist: 12.5, lane: 0.6 })],
      [s({ yaw: 12, elev: 20, dist: 12.5, closedDim: 0.14, lane: 0.6 }), s({ yaw: 16, elev: 24, dist: 12.5, closedDim: 0.14, lane: 0.5 })],
      [
        s({ yaw: 28, elev: 32, dist: 12, burn: 1, flow: 1, gap: 1, closedDim: 0.14, lane: 0.35 }),
        s({ yaw: 34, elev: 36, dist: 12.5, burn: 1, flow: 1, gap: 1, closedDim: 0.14, lane: 0.35 }),
      ],
      [
        s({ focus: "lane", yaw: -20, elev: 22, dist: 9.5, burn: 0.3, flow: 0.15, gap: 1, lift: 1, closedDim: 0.14 }),
        s({ focus: "lane", yaw: -12, elev: 26, dist: 10, burn: 0.3, flow: 0.15, gap: 1, lift: 1, closedDim: 0.14 }),
      ],
      [
        s({ yaw: 14, elev: 26, dist: 11, burn: 0.25, flow: 0.15, gap: 1, lift: 1, recenter: 0, closedDim: 0.14 }),
        // The re-center was planned, not executed (the cost hurdle held it): the lane is drawn lighter as it moves.
        s({ yaw: 26, elev: 32, dist: 16, burn: 0.25, flow: 0.15, gap: 1, lift: 0, recenter: 1, closedDim: 0.14, lane: 0.55 }),
      ],
    ],
  };
}

/**
 * Keyframes in scroll px from the book's top. `acts` are the act elements' [top, bottom] offsets, `vh` the viewport
 * height: an act's camera arrives when its panel is 40% up the screen and holds until its end is 85% up.
 */
export function buildKeys(acts: [number, number][], vh: number, narrow: boolean, hero?: HeroFit): Key[] {
  const sh = shots(narrow, hero);
  const keys: Key[] = [{ at: 0, frame: LAST_FRAME, shot: sh.hero, hold: false }];
  ACTS.forEach((a, i) => {
    const [top, bottom] = acts[i];
    const start = Math.max(keys[keys.length - 1].at + 1, top - 0.4 * vh);
    const end = Math.max(start + 1, bottom - 0.85 * vh);
    keys.push({ at: start, frame: a.frames[0], shot: sh.acts[i][0], hold: true });
    keys.push({ at: end, frame: a.frames[1], shot: sh.acts[i][1], hold: false });
  });
  return keys;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Resolver = { x(t: number): number; z(f: number): number; crest(f: number, tick: number): number };

function target(d: ReliefData, r: Resolver, shot: Shot, frame: number): [number, number, number] {
  if (shot.focus === "plate") return [0, 0.25, r.z(LAST_FRAME * 0.52)];
  if (shot.focus === "lane") {
    const mid = (d.lane.lower + d.lane.upper) / 2;
    return [r.x(mid), 1.6, r.z(frame) - 0.3];
  }
  const pt = frameAt(d, frame, "poolTick");
  const ft = frameAt(d, frame, "fairTick");
  const tick = (pt + ft) / 2;
  return [r.x(tick) * 0.8, 1.0, r.z(frame) - 0.6];
}

const NUM: (keyof Shot)[] = ["yaw", "elev", "dist", "fov", "shiftX", "shiftY", "burn", "flow", "gap", "blades", "lane", "lift", "recenter", "closedDim", "ink"];

/** The scene at scroll offset `s`. Frames advance linearly inside an act; everything else eases. */
export function stateAt(keys: Key[], s: number, d: ReliefData, r: Resolver): ReliefState {
  let i = 0;
  while (i < keys.length - 2 && s > keys[i + 1].at) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const raw = Math.max(0, Math.min(1, (s - a.at) / Math.max(1, b.at - a.at)));
  const t = ease(raw);
  const frame = lerp(a.frame, b.frame, a.hold ? raw : t);
  const ta = target(d, r, a.shot, a.hold ? frame : a.frame);
  const tb = target(d, r, b.shot, a.hold ? frame : b.frame);
  const out = { frame, tx: lerp(ta[0], tb[0], t), ty: lerp(ta[1], tb[1], t), tz: lerp(ta[2], tb[2], t) } as ReliefState;
  for (const k of NUM) (out as unknown as Record<string, number>)[k] = lerp(a.shot[k] as number, b.shot[k] as number, t);
  return out;
}

/** Which act (0-based) a scroll offset belongs to, or -1 in the hero (until the hero has scrolled away). */
export function actAt(keys: Key[], s: number, heroEnd = 0): number {
  if (s < Math.max(keys[1].at - 1, heroEnd)) return -1;
  for (let i = ACTS.length - 1; i >= 0; i--) if (s >= keys[1 + i * 2].at - 1) return i;
  return 0;
}
