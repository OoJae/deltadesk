// Where the relief's blade tags sit (pool, fair value, lane A), in stage pixels. Pure: anchors, tag sizes and the
// fixed panels in, boxes out. Rules: a tag never covers another tag, and never enters the act panel, the readout
// or the timeline. Fair value is the subject of the scene, so it keeps its place and the others move. A tag with
// no clean place (phones, while one act's panel hands over to the next and the two fill the screen) is hidden.

export type Box = { x: number; y: number; w: number; h: number };
export type Tag = { anchor: [number, number] | null; w: number; h: number; show: boolean };
export type Stage = { w: number; h: number; /** Lowest anchor y (keeps tags under the readout band on phones). */ minY: number };

const GAP = 6; // tag to its anchor
const AIR = 8; // tag to anything else
const RISE = 8; // pool/fair tags sit this far above their blade's top

export const hits = (a: Box, b: Box, pad = AIR) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

const inside = (b: Box, s: Stage) => b.x >= AIR && b.x + b.w <= s.w - AIR && b.y >= AIR && b.y + b.h <= s.h - AIR;

const fit = (b: Box, s: Stage): Box => ({
  ...b,
  x: Math.min(Math.max(AIR, b.x), Math.max(AIR, s.w - AIR - b.w)),
  y: Math.min(Math.max(AIR, b.y), Math.max(AIR, s.h - AIR - b.h)),
});

/**
 * Move a box off the obstacles by the smallest step (horizontal steps preferred: a tag keeps its height on the relief
 * and slides along the panel's edge). Steps are continuous in the anchor, so tags glide instead of jumping.
 */
export function clear(b: Box, obstacles: Box[], s: Stage): Box {
  let box = fit(b, s);
  for (let pass = 0; pass < 3; pass++) {
    const o = obstacles.find((ob) => hits(box, ob));
    if (!o) return box;
    const moves: Box[] = [
      { ...box, x: o.x + o.w + AIR },
      { ...box, x: o.x - box.w - AIR },
      { ...box, y: o.y + o.h + AIR },
      { ...box, y: o.y - box.h - AIR },
    ];
    const cost = (m: Box) => Math.abs(m.x - box.x) + 1.5 * Math.abs(m.y - box.y) + (inside(m, s) ? 0 : 1e6) + (obstacles.some((ob) => hits(m, ob)) ? 1e4 : 0);
    box = moves.reduce((best, m) => (cost(m) < cost(best) ? m : best));
  }
  return fit(box, s);
}

export type Placed = { pool: Box | null; fair: Box | null; lane: Box | null };

export function placeTags(s: Stage, obstacles: Box[], pool: Tag, fair: Tag, lane: Tag): Placed {
  const ay = (t: Tag) => Math.max(s.minY, t.anchor![1]);
  let P: Box | null = null;
  let F: Box | null = null;
  if (pool.show && pool.anchor && fair.show && fair.anchor) {
    // The higher price reads on the right (on screen).
    const fairRight = fair.anchor[0] >= pool.anchor[0];
    F = clear(
      { x: fairRight ? fair.anchor[0] + GAP : fair.anchor[0] - fair.w - GAP, y: ay(fair) - fair.h - RISE, w: fair.w, h: fair.h },
      obstacles,
      s,
    );
    P = clear(
      { x: fairRight ? pool.anchor[0] - pool.w - GAP : pool.anchor[0] + GAP, y: ay(pool) - pool.h - RISE, w: pool.w, h: pool.h },
      obstacles,
      s,
    );
    const blocked = (b: Box) => obstacles.some((o) => hits(b, o));
    if (blocked(F)) F = null;
    if (blocked(P)) P = null;
    if (P && F && hits(P, F, 4)) {
      // Stack: the pool tag steps above or below fair value, whichever is nearer its blade and free.
      const f = F;
      const p = P;
      const opts = [
        { ...p, y: f.y + f.h + 4 },
        { ...p, y: f.y - p.h - 4 },
      ].map((b) => fit(b, s));
      const cost = (b: Box) => Math.abs(b.y - p.y) + (obstacles.some((o) => hits(b, o)) || hits(b, f, 3) ? 1e4 : 0);
      const q = opts.reduce((best, b) => (cost(b) < cost(best) ? b : best));
      P = cost(q) < 1e4 ? q : null;
    }
  }

  let L: Box | null = null;
  if (lane.show && lane.anchor) {
    const [lx, ly] = [lane.anchor[0], ay(lane)];
    const up = ly - lane.h + 4; // beside the lane's top edge
    const down = ly + GAP; // just under it, beside the slab's side
    const candidates: Box[] = [
      { x: lx - lane.w - AIR, y: up, w: lane.w, h: lane.h },
      { x: lx + AIR, y: up, w: lane.w, h: lane.h },
      { x: lx - lane.w - AIR, y: down, w: lane.w, h: lane.h },
      { x: lx + AIR, y: down, w: lane.w, h: lane.h },
    ].map((c) => clear(c, obstacles, s));
    const others = [P, F].filter((b): b is Box => b != null);
    // Above or below the blades' tags, too, when the lane sits between them.
    if (others.length) {
      const top = Math.min(...others.map((o) => o.y));
      const bottom = Math.max(...others.map((o) => o.y + o.h));
      for (const y of [top - lane.h - AIR, bottom + AIR]) for (const x of [lx - lane.w - AIR, lx + AIR]) candidates.push(clear({ x, y, w: lane.w, h: lane.h }, obstacles, s));
    }
    const clean = (c: Box) => !others.some((o) => hits(c, o, 4)) && !obstacles.some((o) => hits(c, o));
    L = candidates.find(clean) ?? null;
  }
  return { pool: P, fair: F, lane: L };
}
