// The Engraved Book: the NVDA/USDG pool's real liquidity through one weekend, drawn as engraving.
// Vanilla three.js, loaded only on / (ReliefCanvas → next/dynamic, ssr:false).
//
//   x = price (right = higher NVDA price; tick grows to the left), z = time (one ridge per 30 minutes, Friday at the
//   back, the current frame at the front), y = active liquidity (sqrt-compressed against the 99th percentile).
//
// Ink: every ridge is a 1-device-pixel hairline (LineSegments, no bloom). The terrain under them is an opaque vault
// surface that hides the lines behind it (the engraver's hidden-line plate) and carries its own engraving: contour
// lines and a z-hatch whose stroke swells with liquidity. Two blades stand on the current ridge: pool price (paper)
// and fair value (serial). Informed flow burns the in-range ink red; the lane is an engraved block that lifts out.
// Render on demand only (static geometry, a few uniforms per scroll step).

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  Color,
} from "three";
import { BLADE, WORLD, bucketWindow, frameAt, heightOf, heightRef, type ReliefData } from "./data";

export type ReliefState = {
  frame: number;
  /** Camera: target, then yaw/elevation (degrees) and distance around it. */
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  elev: number;
  dist: number;
  fov: number;
  /** Viewport shift of the projection centre, fraction of width/height (relief to the right = +x). */
  shiftX: number;
  shiftY: number;
  burn: number;
  flow: number;
  gap: number;
  blades: number;
  lane: number;
  lift: number;
  recenter: number;
  /** Frames already engraved stay; this dims the closed-market ridges a touch (the gate is down). */
  closedDim: number;
  /** Master ink of the ridges (lighter behind the hero headline). */
  ink: number;
};

export type ReliefDetail = "full" | "lite";

const PAPER = new Color("#EDE6D6");
const SERIAL = new Color("#E4472B");
const VAULT = new Color("#0A0D0C");

const LANE_LIFT = 1.1;

export type ReliefEngine = {
  setState(s: ReliefState): void;
  resize(w: number, h: number): void;
  render(): void;
  /** Screen position (css px) of a world point, for DOM labels. Null when behind the camera. */
  project(x: number, y: number, z: number): [number, number] | null;
  x(tick: number): number;
  z(frame: number): number;
  /** World y of the lane slab's top at a state. */
  laneTop(s: ReliefState): number;
  crest(frame: number, tick: number): number;
  /** A sparse sample of the drawn relief (world xyz triples: ridge crests and the front baseline), for fitting it beside text. */
  outline: Float32Array;
  segments: number;
  dispose(): void;
};

const RIDGE_VS = /* glsl */ `
uniform float uFrame; uniform float uFogNear; uniform float uFogFar; uniform float uBurn; uniform float uClosedDim; uniform float uInk;
attribute float aFrame; attribute float aBurn; attribute float aClosed;
varying float vAlpha; varying float vBurn;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float engraved = 1.0 - smoothstep(uFrame, uFrame + 1.0, aFrame);
  float age = max(uFrame - aFrame, 0.0);
  float fresh = engraved * (1.0 - smoothstep(0.0, 4.0, age));
  float fog = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
  vAlpha = uInk * engraved * (0.5 - aClosed * uClosedDim + fresh * 0.45) * mix(0.18, 1.0, fog);
  vBurn = aBurn * uBurn * engraved;
}`;
const RIDGE_FS = /* glsl */ `
uniform vec3 uPaper; uniform vec3 uSerial;
varying float vAlpha; varying float vBurn;
void main() { gl_FragColor = vec4(mix(uPaper, uSerial, clamp(vBurn, 0.0, 1.0)), vAlpha * (1.0 + vBurn * 0.6)); }`;

const PLATE_VS = /* glsl */ `
uniform float uFogNear; uniform float uFogFar;
attribute float aFrame; attribute float aH;
varying float vFrame; varying float vH; varying float vFog; varying vec3 vW;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vFrame = aFrame; vH = aH; vW = position;
  vFog = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
}`;
const PLATE_FS = /* glsl */ `
uniform float uFrame; uniform vec3 uPaper; uniform vec3 uVault; uniform float uHatch;
varying float vFrame; varying float vH; varying float vFog; varying vec3 vW;
float hair(float v, float halfWidth) {
  float w = fwidth(v);
  float d = abs(fract(v) - 0.5);
  return 1.0 - smoothstep(halfWidth - w, halfWidth + w, 0.5 - d);
}
void main() {
  if (vFrame > uFrame + 0.001) discard;
  // Contours every 0.09 world units of height (engraved cliff shading) and a hatch along time whose stroke swells
  // with liquidity (the engraver's tint: more ink where there is more liquidity).
  float contour = 1.0 - hair(vW.y / 0.12, 0.05);
  float hatch = 1.0 - hair(vW.x / 0.09, mix(0.02, 0.22, clamp(vH, 0.0, 1.0)));
  float ink = max(contour * 0.32, hatch * 0.2 * smoothstep(0.35, 0.9, vH)) * uHatch * mix(0.1, 1.0, vFog);
  gl_FragColor = vec4(mix(uVault, uPaper, ink * 0.45), 1.0);
}`;

const FLAT_VS = /* glsl */ `
attribute float aFrame; attribute float aAlpha;
uniform float uFrame; uniform float uFogNear; uniform float uFogFar;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float engraved = 1.0 - smoothstep(uFrame, uFrame + 1.0, aFrame);
  float fog = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
  vAlpha = engraved * aAlpha * mix(0.3, 1.0, fog);
}`;
const FLAT_FS = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity;
varying float vAlpha;
void main() { gl_FragColor = vec4(uColor, vAlpha * uOpacity); }`;

function lineMaterial(color: Color, fog: { near: number; far: number }, opacity = 1, depthTest = true) {
  return new ShaderMaterial({
    vertexShader: FLAT_VS,
    fragmentShader: FLAT_FS,
    uniforms: {
      uColor: { value: color },
      uOpacity: { value: opacity },
      uFrame: { value: 0 },
      uFogNear: { value: fog.near },
      uFogFar: { value: fog.far },
    },
    transparent: true,
    depthWrite: false,
    depthTest,
  });
}

export function createRelief(canvas: HTMLCanvasElement, d: ReliefData, detail: ReliefDetail): ReliefEngine {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 200);
  const fog = { near: 6, far: 26 };

  const [b0, b1] = bucketWindow(d);
  const nb = b1 - b0 + 1;
  const F = d.frames.length;
  const ref = heightRef(d);
  const dx = WORLD.width / (nb - 1);
  const x = (tick: number) => WORLD.width / 2 - ((tick - d.grid.tick0) / d.bucketTicks - b0) * dx;
  const xb = (b: number) => WORLD.width / 2 - (b - b0) * dx;
  const z = (f: number) => f * WORLD.dz;
  const hq = (q: number) => WORLD.height * heightOf(q, ref);
  const crestAt = (f: number, tick: number) => {
    const fi = Math.max(0, Math.min(F - 1, Math.round(f)));
    const b = Math.max(0, Math.min(d.grid.n - 1, Math.round((tick - d.grid.tick0) / d.bucketTicks)));
    return hq(d.liq[fi][b]);
  };

  const frameStep = detail === "full" ? 1 : 2;
  const bucketStep = detail === "full" ? 1 : 2;

  // Burn: per frame, the pool-wide value picked off (closed window), normalised to its 90th percentile.
  const picked = d.flowFrame.map((p) => Math.max(0, p[0]));
  const p90 = [...picked].sort((a, b) => a - b)[Math.floor(picked.length * 0.9)] || 1;
  const burnOf = (f: number) => Math.min(1, picked[f] / p90);
  const IN_RANGE = 100; // ticks either side of the pool price: the control lane's width

  // ---- Ridges: one hairline polyline per frame ------------------------------------------------------------------
  const rPos: number[] = [];
  const rFrame: number[] = [];
  const rBurn: number[] = [];
  const rClosed: number[] = [];
  let segments = 0;
  for (let f = 0; f < F; f += frameStep) {
    const q = d.liq[f];
    const fr = d.frames[f];
    const closed = fr.regime === "WEEKEND_DARK" ? 1 : 0;
    const zf = z(f);
    const burn = burnOf(f);
    for (let b = b0; b < b1; b += bucketStep) {
      const b2 = Math.min(b1, b + bucketStep);
      for (const bb of [b, b2]) {
        const tick = d.grid.tick0 + bb * d.bucketTicks;
        const dist = Math.abs(tick - fr.poolTick);
        rPos.push(xb(bb), hq(q[bb]), zf);
        rFrame.push(f);
        rBurn.push(dist < IN_RANGE ? burn * (1 - dist / IN_RANGE) ** 0.6 : 0);
        rClosed.push(closed);
      }
      segments++;
    }
  }
  const ridgeGeo = new BufferGeometry();
  ridgeGeo.setAttribute("position", new Float32BufferAttribute(rPos, 3));
  ridgeGeo.setAttribute("aFrame", new Float32BufferAttribute(rFrame, 1));
  ridgeGeo.setAttribute("aBurn", new Float32BufferAttribute(rBurn, 1));
  ridgeGeo.setAttribute("aClosed", new Float32BufferAttribute(rClosed, 1));
  const ridgeMat = new ShaderMaterial({
    vertexShader: RIDGE_VS,
    fragmentShader: RIDGE_FS,
    uniforms: {
      uFrame: { value: 0 },
      uFogNear: { value: fog.near },
      uFogFar: { value: fog.far },
      uBurn: { value: 0 },
      uClosedDim: { value: 0 },
      uInk: { value: 1 },
      uPaper: { value: PAPER },
      uSerial: { value: SERIAL },
    },
    transparent: true,
    depthWrite: false,
  });
  // Every 8th ridge vertex, both ends of every ridge, and the front baseline (the floor of the page edge at the end).
  const outline: number[] = [];
  const perRidge = (rPos.length / 3) / Math.ceil(F / frameStep);
  for (let v = 0; v < rPos.length / 3; v++) {
    const k = v % perRidge;
    if (v % 8 === 0 || k === 0 || k === perRidge - 1) outline.push(rPos[v * 3], rPos[v * 3 + 1], rPos[v * 3 + 2]);
  }
  for (let k = 0; k <= 24; k++) outline.push(-WORLD.width / 2 + (WORLD.width * k) / 24, 0, z(F - 1));
  const ridges = new LineSegments(ridgeGeo, ridgeMat);
  ridges.renderOrder = 2;
  scene.add(ridges);

  // ---- The plate: opaque terrain that hides lines behind it and carries contour + tint engraving ----------------
  const pPos: number[] = [];
  const pFrame: number[] = [];
  const pH: number[] = [];
  const idx: number[] = [];
  const cols = Math.floor((b1 - b0) / bucketStep) + 1;
  const plateRows: number[] = [];
  for (let f = 0; f < F; f += frameStep) plateRows.push(f);
  for (const f of plateRows) {
    for (let c = 0; c < cols; c++) {
      const b = Math.min(b1, b0 + c * bucketStep);
      const q = d.liq[f][b];
      pPos.push(xb(b), hq(q), z(f));
      pFrame.push(f);
      pH.push(heightOf(q, ref));
    }
  }
  for (let r = 0; r < plateRows.length - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const e = a + cols;
      const g = e + 1;
      idx.push(a, e, b, b, e, g);
    }
  }
  // A skirt down to the floor at the front edge is implied by the floor colour: the canvas is transparent on vault.
  const plateGeo = new BufferGeometry();
  plateGeo.setAttribute("position", new Float32BufferAttribute(pPos, 3));
  plateGeo.setAttribute("aFrame", new Float32BufferAttribute(pFrame, 1));
  plateGeo.setAttribute("aH", new Float32BufferAttribute(pH, 1));
  plateGeo.setIndex(idx);
  const plateMat = new ShaderMaterial({
    vertexShader: PLATE_VS,
    fragmentShader: PLATE_FS,
    uniforms: {
      uFrame: { value: 0 },
      uFogNear: { value: fog.near },
      uFogFar: { value: fog.far },
      uPaper: { value: PAPER },
      uVault: { value: VAULT },
      uHatch: { value: detail === "full" ? 1 : 0.8 },
    },
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  const plate = new Mesh(plateGeo, plateMat);
  plate.renderOrder = 1;
  scene.add(plate);

  // ---- Price traces over the crests: pool (paper) and fair value (serial) ----------------------------------------
  const traceGeo = (key: "poolTick" | "fairTick") => {
    const pos: number[] = [];
    const fr: number[] = [];
    const al: number[] = [];
    for (let f = 0; f < F - 1; f++) {
      for (const g of [f, f + 1]) {
        const t = d.frames[g][key];
        pos.push(x(t), crestAt(g, t) + 0.025, z(g));
        fr.push(g);
        al.push(1);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("aFrame", new Float32BufferAttribute(fr, 1));
    geo.setAttribute("aAlpha", new Float32BufferAttribute(al, 1));
    return geo;
  };
  const poolTraceMat = lineMaterial(PAPER, fog, 0.85);
  const fairTraceMat = lineMaterial(SERIAL, fog, 1);
  const poolTrace = new LineSegments(traceGeo("poolTick"), poolTraceMat);
  const fairTrace = new LineSegments(traceGeo("fairTick"), fairTraceMat);
  poolTrace.renderOrder = fairTrace.renderOrder = 3;
  scene.add(poolTrace, fairTrace);

  // ---- The gap: serial rungs between pool and fair at every frame ------------------------------------------------
  const gPos: number[] = [];
  const gFrame: number[] = [];
  const gAlpha: number[] = [];
  for (let f = 0; f < F; f++) {
    const fr = d.frames[f];
    const y = Math.max(crestAt(f, fr.poolTick), crestAt(f, fr.fairTick)) + 0.03;
    const strength = Math.min(1, Math.abs(fr.gapBps) / 20);
    for (let k = 0; k < 3; k++) {
      const zz = z(f) + (k - 1) * WORLD.dz * 0.3;
      gPos.push(x(fr.poolTick), y, zz, x(fr.fairTick), y, zz);
      gFrame.push(f, f);
      gAlpha.push(0.25 + 0.75 * strength, 0.25 + 0.75 * strength);
    }
  }
  const gapGeo = new BufferGeometry();
  gapGeo.setAttribute("position", new Float32BufferAttribute(gPos, 3));
  gapGeo.setAttribute("aFrame", new Float32BufferAttribute(gFrame, 1));
  gapGeo.setAttribute("aAlpha", new Float32BufferAttribute(gAlpha, 1));
  const gapMat = lineMaterial(SERIAL, fog, 0);
  const gapLines = new LineSegments(gapGeo, gapMat);
  gapLines.renderOrder = 3;
  scene.add(gapLines);

  // ---- Informed flow: short serial scratches where the strongest swaps hit -----------------------------------------
  const fPos: number[] = [];
  const fFrame: number[] = [];
  const fAlpha: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const maxCents = Math.max(...d.flow.map((s) => s[3]), 1);
  for (const [fi, tb, ta, cents] of d.flow) {
    const len = 0.12 + 0.55 * Math.sqrt(cents / maxCents);
    const x0 = x(tb) + (rnd() - 0.5) * 0.18;
    const dir = ta >= tb ? -1 : 1; // price fell (tick up) → scratch leans left
    const y0 = crestAt(fi, tb) + 0.04 + rnd() * 0.08;
    const zz = z(fi) + (rnd() - 0.5) * WORLD.dz;
    fPos.push(x0, y0, zz, x0 + dir * len * 0.9, y0 + len * 0.28, zz + (rnd() - 0.5) * 0.12);
    fFrame.push(fi, fi);
    fAlpha.push(1, 0.35);
  }
  const flowGeo = new BufferGeometry();
  flowGeo.setAttribute("position", new Float32BufferAttribute(fPos, 3));
  flowGeo.setAttribute("aFrame", new Float32BufferAttribute(fFrame, 1));
  flowGeo.setAttribute("aAlpha", new Float32BufferAttribute(fAlpha, 1));
  const flowMat = lineMaterial(SERIAL, fog, 0);
  const flowLines = new LineSegments(flowGeo, flowMat);
  flowLines.renderOrder = 4;
  scene.add(flowLines);

  // ---- The page edge: the current frame's cross-section, an opaque face with vertical engraving -------------------
  const secCols: number[] = [];
  for (let b = b0; b <= b1; b += bucketStep) secCols.push(b);
  const nc = secCols.length;
  const secFace = new Float32Array(nc * 2 * 3);
  const secHatch = new Float32Array(nc * 2 * 3 + 6);
  const secIdx: number[] = [];
  for (let c = 0; c < nc - 1; c++) secIdx.push(c * 2, c * 2 + 1, c * 2 + 2, c * 2 + 2, c * 2 + 1, c * 2 + 3);
  const secFaceGeo = new BufferGeometry();
  secFaceGeo.setAttribute("position", new Float32BufferAttribute(secFace, 3));
  secFaceGeo.setIndex(secIdx);
  const secFaceMat = new ShaderMaterial({
    vertexShader: "void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform vec3 uVault; void main(){ gl_FragColor = vec4(uVault, 1.0); }",
    uniforms: { uVault: { value: VAULT } },
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  const secFaceMesh = new Mesh(secFaceGeo, secFaceMat);
  secFaceMesh.renderOrder = 1;
  const secAlpha = new Float32Array(nc * 2 + 2);
  for (let c = 0; c < nc; c++) {
    secAlpha[c * 2] = 0.06;
    secAlpha[c * 2 + 1] = 0.5;
  }
  secAlpha[nc * 2] = secAlpha[nc * 2 + 1] = 0.7;
  const secHatchGeo = new BufferGeometry();
  secHatchGeo.setAttribute("position", new Float32BufferAttribute(secHatch, 3));
  secHatchGeo.setAttribute("aFrame", new Float32BufferAttribute(new Float32Array(nc * 2 + 2), 1));
  secHatchGeo.setAttribute("aAlpha", new Float32BufferAttribute(secAlpha, 1));
  const secHatchMat = lineMaterial(PAPER, fog, 0.8);
  secHatchMat.uniforms.uFrame.value = 1;
  const secHatchLines = new LineSegments(secHatchGeo, secHatchMat);
  secHatchLines.renderOrder = 2;
  scene.add(secFaceMesh, secHatchLines);
  let secFrame = -1;
  const updateSection = (f: number) => {
    if (Math.abs(f - secFrame) < 0.004) return;
    secFrame = f;
    const x0 = Math.max(0, Math.min(F - 1, f));
    const i0 = Math.floor(x0);
    const i1 = Math.min(F - 1, i0 + 1);
    const t = x0 - i0;
    const zf = z(x0);
    const face = secFaceGeo.attributes.position.array as Float32Array;
    const hatch = secHatchGeo.attributes.position.array as Float32Array;
    for (let c = 0; c < nc; c++) {
      const b = secCols[c];
      const y = hq(d.liq[i0][b]) * (1 - t) + hq(d.liq[i1][b]) * t;
      const px = xb(b);
      face.set([px, 0, zf, px, y, zf], c * 6);
      hatch.set([px, 0, zf + 0.002, px, y, zf + 0.002], c * 6);
    }
    // Baseline: the floor of the book at this frame.
    hatch.set([xb(secCols[0]), 0, zf + 0.002, xb(secCols[nc - 1]), 0, zf + 0.002], nc * 6);
    secFaceGeo.attributes.position.needsUpdate = true;
    secHatchGeo.attributes.position.needsUpdate = true;
    secFaceGeo.computeBoundingSphere();
    secHatchGeo.computeBoundingSphere();
  };

  // ---- Blades: a comb of hairlines rising from the current ridge's crest ----------------------------------------
  const bladeGeo = () => {
    const pos: number[] = [];
    const fr: number[] = [];
    const al: number[] = [];
    const depth = 0.8;
    const lines = 14;
    const h = WORLD.height * BLADE;
    for (let i = 0; i <= lines; i++) {
      const zz = -depth * (i / lines);
      const a = 1 - i / lines;
      pos.push(0, 0, zz, 0, h * (0.35 + 0.65 * a), zz);
      fr.push(0, 0);
      al.push(0.35 + 0.5 * a, 0.02 + 0.55 * a * a);
    }
    // Front edge and top edge, full strength.
    pos.push(0, 0, 0, 0, h, 0, 0, h, 0, 0, h * 0.35, -depth);
    fr.push(0, 0, 0, 0);
    al.push(1, 1, 1, 0.1);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("aFrame", new Float32BufferAttribute(fr, 1));
    geo.setAttribute("aAlpha", new Float32BufferAttribute(al, 1));
    return geo;
  };
  const poolBladeMat = lineMaterial(PAPER, fog, 0);
  const fairBladeMat = lineMaterial(SERIAL, fog, 0);
  const poolBlade = new LineSegments(bladeGeo(), poolBladeMat);
  const fairBlade = new LineSegments(bladeGeo(), fairBladeMat);
  poolBlade.renderOrder = fairBlade.renderOrder = 5;
  scene.add(poolBlade, fairBlade);

  // ---- The lane: its own layer of liquidity, stacked on the book over its real range [lower, upper) ---------------
  // A band that follows the crest under it: a top line, a bottom line, vertical engraving between, and a back edge.
  // In act 04 it peels off the book (lift) keeping the profile it was cut from; in act 05 it moves over fair value.
  const laneGroup = new Group();
  const laneX0 = x(d.lane.upper);
  const laneX1 = x(d.lane.lower);
  const laneW = laneX1 - laneX0;
  const LANE_H = 0.3;
  const LANE_D = 0.5;
  const laneCols = Math.max(2, Math.round(laneW / dx) + 1);
  const laneSegs = (laneCols - 1) * 3 + laneCols + 4;
  const lanePos = new Float32Array(laneSegs * 6);
  const laneAl = new Float32Array(laneSegs * 2);
  {
    let k = 0;
    const setA = (a0: number, a1: number) => {
      laneAl[k * 2] = a0;
      laneAl[k * 2 + 1] = a1;
      k++;
    };
    for (let c = 0; c < laneCols - 1; c++) setA(1, 1); // front top
    for (let c = 0; c < laneCols - 1; c++) setA(0.8, 0.8); // front bottom
    for (let c = 0; c < laneCols - 1; c++) setA(0.4, 0.4); // back top
    for (let c = 0; c < laneCols; c++) setA(0.75, 0.75); // verticals
    for (let e = 0; e < 4; e++) setA(0.7, 0.7); // end connectors
  }
  const laneGeo = new BufferGeometry();
  laneGeo.setAttribute("position", new Float32BufferAttribute(lanePos, 3));
  laneGeo.setAttribute("aFrame", new Float32BufferAttribute(new Float32Array(laneSegs * 2), 1));
  laneGeo.setAttribute("aAlpha", new Float32BufferAttribute(laneAl, 1));
  const laneMat = lineMaterial(PAPER, fog, 0);
  const laneLines = new LineSegments(laneGeo, laneMat);
  laneLines.renderOrder = 6;
  laneGroup.add(laneLines);
  scene.add(laneGroup);

  const tickAtX = (px: number) => d.grid.tick0 + (b0 + (WORLD.width / 2 - px) / dx) * d.bucketTicks;
  const crestX = (f: number, px: number) => {
    const x0 = Math.max(0, Math.min(F - 1, f));
    const i0 = Math.floor(x0);
    const i1 = Math.min(F - 1, i0 + 1);
    const t = x0 - i0;
    return crestAt(i0, tickAtX(px)) * (1 - t) + crestAt(i1, tickAtX(px)) * t;
  };
  const laneBase = (f: number, lx: number) => {
    let m = 0;
    for (let c = 0; c < laneCols; c++) m = Math.max(m, crestX(f, lx + (c / (laneCols - 1)) * laneW));
    return m;
  };
  const updateLane = (f: number, lx: number, lift: number) => {
    // Float32BufferAttribute copies its source array: write into the attribute's own array.
    const P = laneGeo.attributes.position.array as Float32Array;
    let k = 0;
    const put = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      P.set([x0, y0, z0, x1, y1, z1], k * 6);
      k++;
    };
    const cx = (c: number) => lx + (c / (laneCols - 1)) * laneW;
    const base = (c: number) => crestX(f, cx(c)) + 0.015 + lift;
    for (let c = 0; c < laneCols - 1; c++) put(cx(c), base(c) + LANE_H, 0, cx(c + 1), base(c + 1) + LANE_H, 0);
    for (let c = 0; c < laneCols - 1; c++) put(cx(c), base(c), 0, cx(c + 1), base(c + 1), 0);
    for (let c = 0; c < laneCols - 1; c++) put(cx(c), base(c) + LANE_H, -LANE_D, cx(c + 1), base(c + 1) + LANE_H, -LANE_D);
    for (let c = 0; c < laneCols; c++) put(cx(c), base(c), 0, cx(c), base(c) + LANE_H, 0);
    const L = laneCols - 1;
    put(cx(0), base(0) + LANE_H, 0, cx(0), base(0) + LANE_H, -LANE_D);
    put(cx(L), base(L) + LANE_H, 0, cx(L), base(L) + LANE_H, -LANE_D);
    put(cx(0), base(0), 0, cx(0), base(0), -LANE_D);
    put(cx(L), base(L), 0, cx(L), base(L), -LANE_D);
    laneGeo.attributes.position.needsUpdate = true;
    laneGeo.computeBoundingSphere();
  };

  const flatMats = [poolTraceMat, fairTraceMat, gapMat, flowMat, poolBladeMat, fairBladeMat];

  let width = 1;
  let height = 1;
  let state: ReliefState | null = null;

  function applyCamera(s: ReliefState) {
    const yaw = (s.yaw * Math.PI) / 180;
    const el = (s.elev * Math.PI) / 180;
    const cx = s.tx + s.dist * Math.cos(el) * Math.sin(yaw);
    const cy = s.ty + s.dist * Math.sin(el);
    const cz = s.tz + s.dist * Math.cos(el) * Math.cos(yaw);
    camera.position.set(cx, cy, cz);
    camera.fov = s.fov;
    camera.aspect = width / height;
    camera.lookAt(s.tx, s.ty, s.tz);
    // Shift the projection centre so the relief sits beside the text (view offset in pixels of a virtual frame).
    camera.setViewOffset(width, height, -s.shiftX * width, -s.shiftY * height, width, height);
    camera.updateProjectionMatrix();
    fog.near = s.dist * 0.7;
    fog.far = s.dist * 0.7 + 18;
  }

  function setState(s: ReliefState) {
    state = s;
    ridgeMat.uniforms.uFrame.value = s.frame;
    ridgeMat.uniforms.uBurn.value = s.burn;
    ridgeMat.uniforms.uClosedDim.value = s.closedDim;
    ridgeMat.uniforms.uInk.value = s.ink;
    plateMat.uniforms.uFrame.value = s.frame;
    for (const m of [...flatMats, laneMat]) m.uniforms.uFrame.value = m === laneMat || m === poolBladeMat || m === fairBladeMat ? 1 : s.frame;
    poolTraceMat.uniforms.uOpacity.value = 0.85;
    gapMat.uniforms.uOpacity.value = s.gap * 0.9;
    flowMat.uniforms.uOpacity.value = s.flow;
    poolBladeMat.uniforms.uOpacity.value = s.blades * 0.9;
    fairBladeMat.uniforms.uOpacity.value = s.blades;
    laneMat.uniforms.uOpacity.value = s.lane;
    for (const m of [ridgeMat, plateMat, ...flatMats, laneMat]) {
      m.uniforms.uFogNear.value = fog.near;
      m.uniforms.uFogFar.value = fog.far;
    }
    // Blades at the current (fractional) frame.
    const fz = z(s.frame);
    const pt = frameAt(d, s.frame, "poolTick");
    const ft = frameAt(d, s.frame, "fairTick");
    poolBlade.position.set(x(pt), crestAt(s.frame, pt), fz + 0.02);
    fairBlade.position.set(x(ft), crestAt(s.frame, ft), fz + 0.02);
    updateSection(s.frame);
    // Lane: sits on its range at the current ridge; lifts out; re-centres on fair value.
    const fairCentre = x(ft) - laneW / 2;
    const lx = laneX0 + (fairCentre - laneX0) * s.recenter;
    updateLane(s.frame, lx, s.lift * LANE_LIFT);
    laneGroup.position.set(0, 0, fz + 0.03);
    applyCamera(s);
    for (const m of [ridgeMat, plateMat, ...flatMats, laneMat]) {
      m.uniforms.uFogNear.value = fog.near;
      m.uniforms.uFogFar.value = fog.far;
    }
  }

  const v = new Vector3();
  return {
    setState,
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setSize(width, height, false);
      if (state) applyCamera(state);
    },
    render() {
      renderer.render(scene, camera);
    },
    project(px, py, pz) {
      v.set(px, py, pz).project(camera);
      if (v.z > 1) return null;
      return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
    },
    x,
    z,
    laneTop(st) {
      const ft = frameAt(d, st.frame, "fairTick");
      const lx = laneX0 + (x(ft) - laneW / 2 - laneX0) * st.recenter;
      return laneBase(st.frame, lx) + LANE_H + 0.03 + st.lift * LANE_LIFT;
    },
    crest: crestAt,
    outline: new Float32Array(outline),
    segments,
    dispose() {
      scene.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        const mat = m.material as ShaderMaterial | undefined;
        mat?.dispose?.();
      });
      renderer.dispose();
    },
  };
}
